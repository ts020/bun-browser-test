"""Validate process attribution and PSS, including Linux-only live subprocesses."""
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import scaling


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.proc = Path(self.tmp.name)
        self.marker = b'BWT_BENCH_RUN_ID=example'

    def process(self, pid, parent=1, session=50, started=1, marker=None, pss=1024, state='S'):
        path = self.proc / str(pid)
        path.mkdir(exist_ok=True)
        fields = [state, str(parent), str(session), str(session)] + ['0'] * 15 + [str(started)]
        (path / 'stat').write_text(f'{pid} (name with ) parens) ' + ' '.join(fields))
        (path / 'environ').write_bytes((marker or b'') + b'\0')
        (path / 'smaps_rollup').write_text(f'Rss: 9999 kB\nPss: {pss} kB\nPss_Anon: {pss} kB\n')

    def test_detached_and_reparented_children_not_unrelated_chrome(self):
        self.process(10, session=10)
        self.process(11, session=10)  # Bun Chrome after reparenting
        self.process(12, session=12, marker=self.marker)  # Playwright starts a session
        self.process(13, parent=12)  # Child without environment marker
        self.process(14)  # Unrelated browser
        self.process(15, session=10, state='Z')
        known = {}
        self.assertEqual(scaling.run_processes(10, self.marker, known, self.proc), {10, 11, 12, 13})
        self.assertEqual(scaling.sample_pss(known, self.proc), (4, 4))
        # Retain an observed child that has since lost both ancestry and environment.
        self.process(13, started=1)
        self.assertIn(13, scaling.run_processes(10, self.marker, known, self.proc))
        # But never retain a recycled PID.
        self.process(13, started=2)
        self.assertNotIn(13, scaling.run_processes(10, self.marker, known, self.proc))

    def test_exited_process_is_not_missing_memory(self):
        self.process(10, state='Z')
        (self.proc / '10/smaps_rollup').write_text('')
        self.assertEqual(scaling.sample_pss({10, 99}, self.proc), (0, 0))

    def test_live_missing_or_unreadable_pss_fails(self):
        self.process(10)
        (self.proc / '10/smaps_rollup').write_text('Rss: 9999 kB\n')
        with self.assertRaisesRegex(RuntimeError, 'PSS unavailable'):
            scaling.sample_pss({10}, self.proc)
        with patch.object(Path, 'read_text', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                scaling.sample_pss({10}, self.proc)

    @unittest.skipUnless(platform.system() == 'Linux', 'requires Linux /proc')
    def test_live_detached_memory_and_unrelated_process(self):
        # An unrelated 64 MiB process must not inflate the run's peak.
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time; x=bytearray(64*1024*1024); time.sleep(30)'])
        self.addCleanup(lambda: (unrelated.kill(), unrelated.wait()))
        child = 'import time; x=bytearray(24*1024*1024); time.sleep(0.8)'
        parent = f'import subprocess, sys, time; p=subprocess.Popen([sys.executable,"-c",{child!r}], start_new_session=True); time.sleep(0.6); p.wait()'
        code, elapsed, stats = scaling.run_case([sys.executable, '-c', parent], os.environ, self.proc / 'live.log', memory=True)
        self.assertEqual(code, 0)
        self.assertGreater(stats['memory_samples'], 2)
        self.assertGreater(stats['peak_pss_mib'], 24)
        self.assertLess(stats['peak_pss_mib'], 80)
        self.assertGreaterEqual(stats['peak_process_count'], 2)
        self.assertGreater(elapsed, 0.6)
        self.assertIsNone(unrelated.poll())

    @unittest.skipUnless(platform.system() == 'Linux', 'requires Linux /proc')
    def test_timeout_cleans_up_detached_child(self):
        pid_file = self.proc / 'child.pid'
        child = 'import time; time.sleep(30)'
        parent = f'import subprocess, sys, time; from pathlib import Path; p=subprocess.Popen([sys.executable,"-c",{child!r}], start_new_session=True); Path({str(pid_file)!r}).write_text(str(p.pid)); time.sleep(30)'
        with self.assertRaises((subprocess.TimeoutExpired, RuntimeError)):
            scaling.run_case([sys.executable, '-c', parent], os.environ, self.proc / 'timeout.log', memory=True, timeout=0.5)
        pid = int(pid_file.read_text())
        # A zombie is no longer running and consumes no PSS.
        for _ in range(20):
            if scaling.sample_pss({pid}) == (0, 0):
                break
            time.sleep(0.05)
        self.assertEqual(scaling.sample_pss({pid}), (0, 0))


if __name__ == '__main__':
    unittest.main()
