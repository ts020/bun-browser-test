#!/usr/bin/env python3
"""bun-webview-test と vitest browser mode (Playwright) の実行時間とメモリを比べる。

使い方: python3 bench.py [runs]
- 実行時間: プロセスを起動してから終了するまでの wall time
- メモリ: 実行中 50ms ごとに、起動したプロセスの子孫と Chromium のプロセスの PSS を合計した最大値
  （PSS は共有メモリをプロセス数で割るので、Chromium の多プロセスを足しても二重に数えない）
- cold: 各ツールのキャッシュ（vitest は node_modules/.vite と .vitest、bun-webview-test は node_modules/.bwt）を消してから実行
- warm: 続けて同じものをもう一度実行
"""
import os, re, shutil, statistics, subprocess, sys, threading, time, json

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.normpath(os.path.join(HERE, "../.."))
SUITE_V = os.path.join(HERE, "test/browser")
STARTUP = os.path.join(HERE, "startup")
CHROME_DIR = os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers")

env = {k: v for k, v in os.environ.items() if k not in ("CLAUDECODE", "AI_AGENT", "AGENT")}
env.update(NO_COLOR="1", FORCE_COLOR="0", CI="1")
VITEST = os.path.join(HERE, "node_modules/.bin/vitest")

CASES = {
    # 移植した vitest v5.0.3 の test/browser/test（21 ファイル / 127 テスト）
    "suite": {
        "bwt": dict(cmd=["bun", "test", "test/browser/test"], cwd=PKG,
                    caches=[os.path.join(PKG, "test/browser/node_modules/.bwt")]),
        "vitest": dict(cmd=[VITEST, "run"], cwd=SUITE_V,
                       caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(SUITE_V, "node_modules/.vite"), os.path.join(SUITE_V, ".vitest")]),
        # bun test --parallel（既定は CPU のコア数のワーカー）
        "bwt-par": dict(cmd=["bun", "test", "--parallel", "test/browser/test"], cwd=PKG,
                        caches=[os.path.join(PKG, "test/browser/node_modules/.bwt")]),
        # ワーカーがファイルごとに global を作り直さない（preload で立てたサーバーと Chrome をファイル間で使い回せる）
        "bwt-par-noiso": dict(cmd=["bun", "test", "--parallel", "--no-isolate", "test/browser/test"], cwd=PKG,
                              caches=[os.path.join(PKG, "test/browser/node_modules/.bwt")]),
        "bwt-par2": dict(cmd=["bun", "test", "--parallel=2", "test/browser/test"], cwd=PKG,
                         caches=[os.path.join(PKG, "test/browser/node_modules/.bwt")]),
        # ワーカー数を bun と同じコア数にそろえた場合
        "vitest-w4": dict(cmd=[VITEST, "run", f"--maxWorkers={os.cpu_count()}"], cwd=SUITE_V,
                          caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(SUITE_V, "node_modules/.vite"), os.path.join(SUITE_V, ".vitest")]),
        # vitest-browser-bun（vitest を Bun で動かし、provider に Bun.WebView を使う）。既定のファクトリは 1 ファイルずつ
        "vbb": dict(cmd=["bun", "run", "--bun", VITEST, "run"], cwd=SUITE_V, env={"BENCH_PROVIDER": "bun"},
                    caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(SUITE_V, "node_modules/.vite"), os.path.join(SUITE_V, ".vitest")]),
        # vitest-browser-bun + bun-webview-parallel（プールあり）で、コア数のワーカー
        "vbb-par": dict(cmd=["bun", "run", "--bun", VITEST, "run", f"--maxWorkers={os.cpu_count()}"], cwd=SUITE_V, env={"BENCH_PROVIDER": "bun-parallel"},
                        caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(SUITE_V, "node_modules/.vite"), os.path.join(SUITE_V, ".vitest")]),
        # bun test と同じく 1 ファイルずつ順に動かした場合
        "vitest-seq": dict(cmd=[VITEST, "run", "--no-file-parallelism"], cwd=SUITE_V,
                           caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(SUITE_V, "node_modules/.vite"), os.path.join(SUITE_V, ".vitest")]),
    },
    # 1 テストだけのファイル。起動と終了にかかる時間
    "startup": {
        # bunfig.toml の pathIgnorePatterns で bench/ を外しているので、それを打ち消す
        "bwt": dict(cmd=["bun", "test", "--path-ignore-patterns=__none__", os.path.join(STARTUP, "trivial.test.ts")], cwd=PKG,
                    caches=[os.path.join(STARTUP, "node_modules/.bwt")]),
        "vitest": dict(cmd=[VITEST, "run"], cwd=STARTUP,
                       caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(STARTUP, "node_modules/.vite"), os.path.join(STARTUP, ".vitest")]),
        "vbb": dict(cmd=["bun", "run", "--bun", VITEST, "run"], cwd=STARTUP, env={"BENCH_PROVIDER": "bun"},
                    caches=[os.path.join(HERE, "node_modules/.vite"), os.path.join(STARTUP, "node_modules/.vite"), os.path.join(STARTUP, ".vitest")]),
    },
}


def pss_kb(pid):
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for line in f:
                if line.startswith("Pss:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return 0


def procs():
    out = {}
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/stat") as f:
                s = f.read()
            ppid = int(s[s.rfind(")") + 2:].split()[1])
            exe = os.readlink(f"/proc/{d}/exe") if os.path.exists(f"/proc/{d}/exe") else ""
        except OSError:
            continue
        out[int(d)] = (ppid, exe)
    return out


def tree_pss(root):
    ps = procs()
    children = {}
    for pid, (ppid, _) in ps.items():
        children.setdefault(ppid, []).append(pid)
    seen, stack = set(), [root]
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        stack.extend(children.get(p, []))
    # 親から切り離された Chromium も数える（ほかに Chromium は動いていない前提）
    seen |= {pid for pid, (_, exe) in ps.items() if exe.startswith(CHROME_DIR)}
    return sum(pss_kb(p) for p in seen)


def cpu_seconds():
    # マシン全体の user + system 時間（ほかに重い処理は動いていない前提）
    with open("/proc/stat") as f:
        v = f.readline().split()[1:]
    return (int(v[0]) + int(v[1]) + int(v[2])) / os.sysconf("SC_CLK_TCK")


def run(c):
    peak = 0
    c0 = cpu_seconds()
    t0 = time.perf_counter()
    p = subprocess.Popen(c["cmd"], cwd=c["cwd"], env={**env, **c.get("env", {})}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    done = threading.Event()

    def sample():
        nonlocal peak
        while not done.is_set():
            peak = max(peak, tree_pss(p.pid))
            time.sleep(0.05)

    th = threading.Thread(target=sample)
    th.start()
    out = p.communicate()[0]
    wall = time.perf_counter() - t0
    done.set()
    th.join()
    cpu = cpu_seconds() - c0
    # 残った Chromium がいないことを確かめる
    time.sleep(0.3)
    left = [pid for pid, (_, exe) in procs().items() if exe.startswith(CHROME_DIR)]
    # vitest は "Tests  1 failed | 125 passed"、bun test は " 126 pass" / " 0 fail"
    tests = re.search(r"^\s*Tests\s+(.*)$", out, re.M)
    line = tests.group(1) if tests else out
    passed = re.search(r"(\d+) pass(?:ed)?\b", line)
    failed = re.search(r"(\d+) fail(?:ed)?\b", line)
    return dict(wall=wall, cpu=cpu, peak_mb=peak / 1024, code=p.returncode, leftover=len(left),
                passed=passed and int(passed.group(1)), failed=failed and int(failed.group(1)), tail=out[-400:])


def main():
    runs = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    only = sys.argv[2:] or None  # 例: "suite/bwt-par-noiso"（複数可、前方一致）
    results = {}
    for case, tools in CASES.items():
        for tool, c in tools.items():
            if only and not any(f"{case}/{tool}".startswith(o) for o in only):
                continue
            # 1 回目はディスクキャッシュを温めるための捨て実行
            run(c)
            rows = {"cold": [], "warm": []}
            for i in range(runs):
                for d in c["caches"]:
                    shutil.rmtree(d, ignore_errors=True)
                rows["cold"].append(run(c))
                rows["warm"].append(run(c))
            results[f"{case}/{tool}"] = rows
            for kind, rs in rows.items():
                w = [r["wall"] for r in rs]
                m = [r["peak_mb"] for r in rs]
                cp = [r["cpu"] for r in rs]
                print(f"{case:8} {tool:13} {kind}: wall median {statistics.median(w):.2f}s "
                      f"(min {min(w):.2f} max {max(w):.2f})  peak PSS median {statistics.median(m):.0f}MB "
                      f"(max {max(m):.0f})  cpu median {statistics.median(cp):.1f}s  pass={rs[-1]['passed']} fail={rs[-1]['failed']} leftover={rs[-1]['leftover']}",
                      flush=True)
    with open(os.path.join(HERE, f"results{'-' + '+'.join(only).replace('/', '_') if only else ''}.json"), "w") as f:
        json.dump(results, f, indent=1)


main()
