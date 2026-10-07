#!/usr/bin/env python3
"""Benchmark a repeated browser workload, optionally comparing with Vitest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import statistics
import subprocess
import threading
import time
import uuid

BENCH = Path(__file__).resolve().parent
REPO = BENCH.parents[1]
SOURCE = REPO / 'test/browser'
WORK = BENCH / '.scaling'
FILES = ['basic', 'dom', 'env', 'findElement', 'utils']  # 40 tests, 5 screenshots per group
SAMPLE_INTERVAL = 0.05


def run_processes(root, marker, known, proc_dir=Path('/proc')):
    """Include reparented/browser processes; never include unrelated Chrome instances.

    Bun's shared Chrome is reparented and Playwright starts a new session. The
    inherited per-run environment marker catches both, even between samples.
    Start times guard against PID reuse after an observed process exits.
    """
    processes = {}
    for entry in proc_dir.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            pid = int(entry.name)
            processes[pid] = (int(fields[1]), int(fields[3]), int(fields[19]), fields[0])
        except (FileNotFoundError, ProcessLookupError):
            continue
    selected = set()
    for pid, (_, session, started, state) in processes.items():
        if state == 'Z':
            continue
        if session == root or known.get(pid) == started:
            selected.add(pid)
            continue
        try:
            if marker in (proc_dir / str(pid) / 'environ').read_bytes().split(b'\0'):
                selected.add(pid)
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            # Unrelated users' environments are normally inaccessible.
            pass
    while True:
        children = {pid for pid, (parent, _, _, state) in processes.items() if parent in selected and state != 'Z'}
        if children <= selected:
            break
        selected |= children
    known.clear()
    known.update({pid: processes[pid][2] for pid in selected})
    return selected


def sample_pss(pids, proc_dir=Path('/proc')):
    total_kib, count = 0, 0
    for pid in pids:
        try:
            text = (proc_dir / str(pid) / 'smaps_rollup').read_text()
        except (FileNotFoundError, ProcessLookupError):
            continue  # A process can exit during a sample.
        # Permission errors and missing PSS must fail, not silently count as zero.
        match = re.search(r'^Pss:\s+(\d+) kB$', text, re.M)
        if not match:
            try:
                if (proc_dir / str(pid) / 'stat').read_text().rsplit(')', 1)[1].split()[0] == 'Z':
                    continue
            except (FileNotFoundError, ProcessLookupError):
                continue
            raise RuntimeError(f'PSS unavailable for process {pid}')
        total_kib += int(match[1])
        count += 1
    return total_kib / 1024, count


def run_case(command, env, log_path, memory=False, timeout=180):
    linux = platform.system() == 'Linux'
    token = uuid.uuid4().hex
    marker = f'BWT_BENCH_RUN_ID={token}'.encode()
    known = {}
    done = threading.Event()
    errors = []
    stats = {'peak_pss_mib': 0, 'memory_samples': 0, 'peak_process_count': 0}
    with log_path.open('w') as log:
        start = time.perf_counter()
        process = subprocess.Popen(command, cwd=REPO, env={**env, 'BWT_BENCH_RUN_ID': token},
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name == 'posix')

        def sample():
            try:
                while not done.is_set():
                    tick = time.perf_counter()
                    pss, count = sample_pss(run_processes(process.pid, marker, known))
                    if count:
                        stats['memory_samples'] += 1
                        if pss > stats['peak_pss_mib']:
                            stats.update(peak_pss_mib=pss, peak_process_count=count)
                    done.wait(max(0, SAMPLE_INTERVAL - (time.perf_counter() - tick)))
            except Exception as error:
                errors.append(error)

        sampler = threading.Thread(target=sample) if memory else None
        if sampler:
            sampler.start()
        try:
            code = process.wait(timeout=timeout)
            elapsed = time.perf_counter() - start
        except subprocess.TimeoutExpired:
            log.write(f'\nBenchmark timed out after {timeout} seconds.\n')
            raise
        finally:
            done.set()
            if sampler:
                sampler.join()
            if process.poll() is None:
                if os.name == 'posix':
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()
                process.wait()
            if linux:
                # Shared Chrome exits shortly after its worker. Wait outside the
                # timing interval so the next runner cannot inherit its memory.
                deadline = time.monotonic() + 3
                while remaining := run_processes(process.pid, marker, known):
                    if time.monotonic() >= deadline:
                        for pid in remaining:
                            try:
                                os.kill(pid, signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                        raise RuntimeError(f'Benchmark left {len(remaining)} processes running; killed them')
                    time.sleep(SAMPLE_INTERVAL)
        if errors:
            raise RuntimeError('Memory sampling failed; refusing to report partial PSS') from errors[0]
        if memory and not stats['memory_samples']:
            raise RuntimeError('No PSS samples collected')
    return code, elapsed, stats if memory else {}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--chrome', default=os.environ.get('BUN_CHROME_PATH'), help='Compare both runners using this regular Chrome executable')
    parser.add_argument('--chrome-shell', help='Compare both runners using this Chrome Headless Shell executable; can be used alone')
    parser.add_argument('--bun-only', action='store_true', help='Measure only Bun; skip Node/Playwright setup and Vitest runs')
    parser.add_argument('--groups', type=int, default=20)
    parser.add_argument('--workers', type=int, default=2)
    parser.add_argument('--runs', type=int, default=3)
    parser.add_argument('--webkit', action='store_true', help='Also measure WKWebView on macOS')
    parser.add_argument('--memory', action='store_true', help='Linux only: add separate process-tree peak PSS runs for every runner')
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
    if args.memory and platform.system() != 'Linux':
        parser.error('--memory requires Linux /proc; memory is not approximated with RSS on other OSes')
    if args.memory:
        sample_pss({os.getpid()})  # Fail before installing dependencies if /proc is restricted.

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
    config = config.replace('defineConfig({', 'defineConfig({\n  viewport: { width: 414, height: 896 },')
    (WORK / 'bwt.config.ts').write_text(config)
    package = {'private': True, 'type': 'module'}
    if not args.bun_only:
        package['dependencies'] = {
            'vitest': '5.0.3', '@vitest/browser-playwright': '5.0.3', 'playwright': '1.56.1',
            '@vitest/cjs-lib': 'file:./cjs-lib', '@vitest/bundled-lib': 'file:./bundled-lib',
        }
    (WORK / 'package.json').write_text(json.dumps(package, indent=2))
    if not args.bun_only:
        subprocess.run(['npm', 'install', '--prefix', str(WORK), '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
        shutil.copy2(BENCH / 'scaling-vitest.config.mts', WORK / 'vitest.config.mts')
    else:
        # Do not publish stale comparison artifacts when switching modes.
        for name in ['package-lock.json', 'vitest.config.mts']:
            (WORK / name).unlink(missing_ok=True)

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
        commands['chrome'] = bun_command
        if not args.bun_only:
            commands['vitest'] = vitest_command
    if args.webkit:
        commands['webkit'] = bun_command
    if chrome_shell:
        commands['chrome-shell'] = bun_command
        if not args.bun_only:
            commands['vitest-shell'] = vitest_command
    env = dict(os.environ, CI='1', NO_COLOR='1', FORCE_COLOR='0', BENCH_WORKERS=str(args.workers))
    for key in ['BWT_CONFIG', 'BWT_SHARED_CHROME', 'BWT_PROFILE_LOG', 'BWT_DEBUG']:
        env.pop(key, None)
    metadata = {
        'os': platform.platform(), 'workers': args.workers, 'groups': args.groups,
        'warmup_runs': 1, 'measured_runs': args.runs, 'cpu_count': os.cpu_count(),
        'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
        'bun': subprocess.check_output(['bun', '--revision'], text=True).strip(),
        'mode': 'bun-only' if args.bun_only else 'comparison',
        'vitest': '5.0.3',  # Also used by Bun's browser test runtime.
        'test_sha256': {name: hashlib.sha256((SOURCE / f'test/{name}.test.ts').read_bytes()).hexdigest() for name in FILES},
        'measurement': 'Fresh processes, sequential runners, rotated order, wall time including startup/exit. Repeated fixtures. Memory uses separate runs when enabled.',
        'runner_settings': {
            'bun': {'parallel': args.workers, 'isolate': False, 'browser_document_per_file': True},
            'viewport': {'width': 414, 'height': 896},
        },
        'commands': commands,
        'memory': {'enabled': args.memory, 'metric': 'peak process-tree PSS', 'unit': 'MiB',
                   'sample_interval_ms': SAMPLE_INTERVAL * 1000, 'separate_runs': True,
                   'scope': 'Runner, workers, servers and browser processes, including reparented processes identified by a unique inherited run marker. Sampler excluded.'},
    }
    if not args.bun_only:
        metadata['node'] = subprocess.check_output(['node', '--version'], text=True).strip()
        metadata['playwright'] = '1.56.1'
        metadata['runner_settings']['vitest'] = {'maxWorkers': args.workers, 'fileParallelism': True, 'browser_isolate': True}
    if chrome:
        metadata['chromium_executable'] = str(chrome)
        metadata['chromium'] = subprocess.check_output([str(chrome), '--version'], text=True).strip()
    if chrome_shell:
        metadata['chromium_shell_executable'] = str(chrome_shell)
        metadata['chromium_shell'] = subprocess.check_output([str(chrome_shell), '--version'], text=True).strip()
    (WORK / 'metadata.json').write_text(json.dumps(metadata, indent=2))
    runners = list(commands)
    rows = []
    for phase in (['timing', 'memory'] if args.memory else ['timing']):
        for iteration in range(args.runs + 1):
            order = runners[iteration % len(runners):] + runners[:iteration % len(runners)]
            for runner in order:
                env['BWT_BACKEND'] = 'webkit' if runner == 'webkit' else 'chrome'
                env['BUN_CHROME_PATH'] = str(chrome_shell if runner.endswith('-shell') else chrome or chrome_shell)
                log_path = WORK / f'{runner}-{phase}-{iteration}.log'
                code, elapsed, memory_stats = run_case(commands[runner], env, log_path, memory=phase == 'memory')
                output = log_path.read_text()
                tests, files = 40 * args.groups, len(paths)
                if runner.startswith('vitest'):
                    passed = bool(re.search(rf'Tests\s+{tests} passed \({tests}\)', output) and re.search(rf'Test Files\s+{files} passed \({files}\)', output))
                else:
                    passed = bool(re.search(rf'\n\s*{tests} pass\b', output) and re.search(r'\n\s*0 fail\b', output) and f'across {files} files' in output)
                row = dict(runner=runner, phase=phase, iteration=iteration, seconds=elapsed, ok=code == 0 and passed, **memory_stats)
                rows.append(row)
                (WORK / 'results.json').write_text(json.dumps(rows, indent=2))
                print(json.dumps(row), flush=True)
                if not row['ok']:
                    raise RuntimeError(output[-6000:])
    medians = {runner: statistics.median(r['seconds'] for r in rows if r['runner'] == runner and r['iteration'] > 0 and r['phase'] == 'timing') for runner in runners}
    memory_medians = {runner: statistics.median(r['peak_pss_mib'] for r in rows if r['runner'] == runner and r['iteration'] > 0 and r['phase'] == 'memory') for runner in runners} if args.memory else {}
    summary = {'medians': medians, 'median_peak_pss_mib': memory_medians}
    for browser, bun_runner, vitest_runner in [('chrome', 'chrome', 'vitest'), ('shell', 'chrome-shell', 'vitest-shell')]:
        if bun_runner in medians and vitest_runner in medians:
            summary[f'{browser}_time_reduction_vs_vitest_percent'] = 100 * (1 - medians[bun_runner] / medians[vitest_runner])
            if memory_medians:
                summary[f'{browser}_memory_reduction_vs_vitest_percent'] = 100 * (1 - memory_medians[bun_runner] / memory_medians[vitest_runner])
    (WORK / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    settings = f'Bun: `--parallel={args.workers} --no-isolate`; fresh browser document per file.'
    if not args.bun_only:
        settings += (f' Vitest: `maxWorkers: {args.workers}`, `fileParallelism: true`, `browser.isolate: true`. '
                     "Bun's flag controls host isolation, not browser isolation.")
    report = [
        '## Browser benchmark', '',
        f'{len(paths)} files / {40 * args.groups} tests / {args.workers} workers. '
        f'One warmup per phase, median of {args.runs} measured runs; startup and exit included.', '',
        settings, '',
        '| Runner | Median time (s) | Median peak PSS (MiB) |', '| --- | ---: | ---: |',
        *[f'| {runner} | {seconds:.3f} | {format(memory_medians[runner], ".1f") if runner in memory_medians else "not measured"} |' for runner, seconds in medians.items()], '',
    ]
    for browser in ['chrome', 'shell']:
        for metric in ['time', 'memory']:
            key = f'{browser}_{metric}_reduction_vs_vitest_percent'
            if key in summary:
                report.append(f'{browser}: bun-webview-test {metric} reduction vs Vitest: {summary[key]:.1f}% (negative means higher cost).')
    if args.memory:
        report += ['', 'Memory is sampled in separate executions at a target interval of 50 ms, so sampling does not affect the timing column. '
                   'PSS includes the runner, workers, servers and browser processes (including reparented children); shared pages are proportionally counted. '
                   'Each sample sums live processes; the column is the median of per-run peaks, not a sum of individual process peaks. '
                   'Sampling may miss brief peaks. The Python sampler is excluded.']
    if not args.bun_only:
        report += ['', 'Both runners use the same browser executable for each pair, workload, viewport and worker limit. '
                   'Browser launch flags, process counts and storage/context lifetimes remain implementation-specific.']
    report += ['', 'Hosted-runner results vary; these results are informational, not a performance gate.', '']
    (WORK / 'summary.md').write_text('\n'.join(report))
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
