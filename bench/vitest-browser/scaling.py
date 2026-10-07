#!/usr/bin/env python3
"""Compare the same repeated browser workload, including process startup/exit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import statistics
import subprocess
import time

BENCH = Path(__file__).resolve().parent
REPO = BENCH.parents[1]
SOURCE = REPO / 'test/browser'
WORK = BENCH / '.scaling'
FILES = ['basic', 'dom', 'env', 'findElement', 'utils']  # 40 tests, 5 screenshots per group


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', default=os.environ.get('BUN_CHROME_PATH'), help='Compare both runners using this regular Chrome executable')
    parser.add_argument('--chrome-shell', help='Compare both runners using this Chrome Headless Shell executable; can be used alone')
    parser.add_argument('--groups', type=int, default=20)
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--webkit', action='store_true', help='Also measure WKWebView on macOS')
    args = parser.parse_args()
    if min(args.groups, args.workers, args.runs) < 1:
        parser.error('groups, workers and runs must be positive')
    if not args.chrome and not args.chrome_shell:
        parser.error('provide --chrome or --chrome-shell')
    chrome = Path(args.chrome).expanduser().resolve() if args.chrome else None
    if chrome is not None and not chrome.is_file():
        parser.error(f'Chrome executable not found: {chrome}')
    chrome_shell = Path(args.chrome_shell).expanduser().resolve() if args.chrome_shell else None
    if chrome_shell is not None and not chrome_shell.is_file():
        parser.error(f'Chrome Headless Shell executable not found: {chrome_shell}')
    if args.webkit and platform.system() != 'Darwin':
        parser.error('WKWebView requires macOS')

    WORK.mkdir(exist_ok=True)
    for pattern in ['*.log', 'results.json', 'metadata.json', 'summary.json', 'summary.md']:
        for old in WORK.glob(pattern):
            old.unlink()
    for name in ['src', 'cjs-lib', 'bundled-lib']:
        shutil.copytree(SOURCE / name, WORK / name, dirs_exist_ok=True)
    for name in ['custom-tester.html', 'injected.ts', '.env.local']:
        shutil.copy2(SOURCE / name, WORK / name)
    config_path = os.path.relpath(REPO / 'src/vitest/config', WORK).replace(os.sep, '/')
    config = (SOURCE / 'bwt.config.ts').read_text().replace('"../../src/vitest/config"', json.dumps(config_path))
    (WORK / 'bwt.config.ts').write_text(config)
    (WORK / 'package.json').write_text(json.dumps({
        'private': True, 'type': 'module',
        'dependencies': {
            'vitest': '5.0.3', '@vitest/browser-playwright': '5.0.3', 'playwright': '1.56.1',
            '@vitest/cjs-lib': 'file:./cjs-lib', '@vitest/bundled-lib': 'file:./bundled-lib',
        },
    }, indent=2))
    subprocess.run(['npm', 'install', '--prefix', str(WORK), '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
    shutil.copy2(BENCH / 'scaling-vitest.config.mts', WORK / 'vitest.config.mts')

    # Drop only this script's generated groups, so changing --groups cannot leave extra tests.
    for group in WORK.glob('g[0-9]*'):
        if group.is_dir():
            shutil.rmtree(group)
    paths = []
    for n in range(args.groups):
        group = WORK / f'g{n:03d}'
        shutil.copytree(SOURCE / 'src', group / 'src')
        (group / 'test').mkdir()
        shutil.copytree(SOURCE / 'test/__snapshots__', group / 'test/__snapshots__')
        for name in FILES:
            path = group / f'test/{name}.test.ts'
            shutil.copy2(SOURCE / f'test/{name}.test.ts', path)
            paths.append(str(path))

    bun_command = ['bun', 'test', f'--parallel={args.workers}', '--no-isolate', '--path-ignore-patterns=__none__', *paths]
    vitest_command = ['node', str(WORK / 'node_modules/vitest/vitest.mjs'), 'run', '--config', str(WORK / 'vitest.config.mts'), '--no-color']
    commands = {}
    if chrome:
        commands.update(chrome=bun_command, vitest=vitest_command)
    if args.webkit:
        commands['webkit'] = bun_command
    if chrome_shell:
        commands['chrome-shell'] = bun_command
        commands['vitest-shell'] = vitest_command
    env = dict(os.environ, CI='1', NO_COLOR='1', FORCE_COLOR='0', BENCH_WORKERS=str(args.workers))
    for key in ['BWT_CONFIG', 'BWT_SHARED_CHROME', 'BWT_PROFILE_LOG', 'BWT_DEBUG']:
        env.pop(key, None)
    metadata = {
        'os': platform.platform(), 'workers': args.workers, 'groups': args.groups,
        'warmup_runs': 1, 'measured_runs': args.runs, 'cpu_count': os.cpu_count(),
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
        'bun': subprocess.check_output(['bun', '--revision'], text=True).strip(),
        'node': subprocess.check_output(['node', '--version'], text=True).strip(),
        'vitest': '5.0.3', 'playwright': '1.56.1',
        'test_sha256': {name: hashlib.sha256((SOURCE / f'test/{name}.test.ts').read_bytes()).hexdigest() for name in FILES},
        'measurement': 'Fresh processes, sequential runners, rotated order, wall time including startup/exit. Repeated fixtures; memory not measured.',
    }
    if chrome:
        metadata['chromium_executable'] = str(chrome)
        metadata['chromium'] = subprocess.check_output([str(chrome), '--version'], text=True).strip()
    if chrome_shell:
        metadata['chromium_shell_executable'] = str(chrome_shell)
        metadata['chromium_shell'] = subprocess.check_output([str(chrome_shell), '--version'], text=True).strip()
    (WORK / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    runners = list(commands)
    rows = []
    for iteration in range(args.runs + 1):
        order = runners[iteration % len(runners):] + runners[:iteration % len(runners)]
        for runner in order:
            env['BWT_BACKEND'] = 'webkit' if runner == 'webkit' else 'chrome'
            env['BUN_CHROME_PATH'] = str(chrome_shell if runner.endswith('-shell') else chrome or chrome_shell)
            start = time.perf_counter()
            try:
                result = subprocess.run(commands[runner], cwd=REPO, env=env, capture_output=True, text=True, timeout=180)
            except subprocess.TimeoutExpired as error:
                output = b''.join(part.encode() if isinstance(part, str) else part or b'' for part in [error.stdout, error.stderr])
                (WORK / f'{runner}-{iteration}.log').write_bytes(output + b'\nBenchmark timed out after 180 seconds.\n')
                raise
            elapsed = time.perf_counter() - start
            output = result.stdout + result.stderr
            (WORK / f'{runner}-{iteration}.log').write_text(output)
            tests, files = 40 * args.groups, len(paths)
            if runner.startswith('vitest'):
                passed = bool(re.search(rf'Tests\s+{tests} passed \({tests}\)', output) and re.search(rf'Test Files\s+{files} passed \({files}\)', output))
            else:
                passed = bool(re.search(rf'\n\s*{tests} pass\b', output) and re.search(r'\n\s*0 fail\b', output) and f'across {files} files' in output)
            row = dict(runner=runner, iteration=iteration, seconds=elapsed, ok=result.returncode == 0 and passed)
            rows.append(row)
            (WORK / 'results.json').write_text(json.dumps(rows, indent=2))
            print(json.dumps(row), flush=True)
            if not row['ok']:
                raise RuntimeError(output[-6000:])
    medians = {runner: statistics.median(r['seconds'] for r in rows if r['runner'] == runner and r['iteration'] > 0) for runner in runners}
    summary = {'medians': medians}
    if chrome:
        summary['chrome_time_reduction_vs_vitest_percent'] = 100 * (1 - medians['chrome'] / medians['vitest'])
    if chrome_shell:
        summary['shell_time_reduction_vs_vitest_percent'] = 100 * (1 - medians['chrome-shell'] / medians['vitest-shell'])
    (WORK / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    report = [
        '## Browser benchmark', '',
        f'{len(paths)} files / {40 * args.groups} tests / {args.workers} workers. '
        f'One warmup, median of {args.runs} measured runs; startup and exit included.', '',
        '| Runner | Median (seconds) |', '| --- | ---: |',
        *[f'| {runner} | {seconds:.3f} |' for runner, seconds in medians.items()], '',
    ]
    for browser in ['chrome', 'shell']:
        key = f'{browser}_time_reduction_vs_vitest_percent'
        if key in summary:
            report.append(f'{browser}: bun-webview-test time reduction vs Vitest: {summary[key]:.1f}% (negative means slower).')
    report += ['', 'Both runners use the same browser executable for each pair. '
               'Hosted-runner timings vary; these results are informational, not a performance gate. Memory is not measured.', '']
    (WORK / 'summary.md').write_text('\n'.join(report))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
