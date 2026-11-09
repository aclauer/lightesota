"""Deployment policy checks; deliberately never execute the deployment script."""
from pathlib import Path
import re
import subprocess
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "deploy.sh"


class DeployPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SCRIPT.read_text()

    def test_shell_syntax(self):
        result = subprocess.run(["bash", "-n", str(SCRIPT)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_embedded_remote_commands_parse_without_running(self):
        commands = re.findall(r"<<'REMOTE'\n(.*?)\nREMOTE", self.source, re.DOTALL)
        self.assertEqual(len(commands), 3)
        for command in commands:
            result = subprocess.run(["sh", "-n"], input=command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_archive_and_manifest_come_from_one_immutable_commit(self):
        self.assertIn('git rev-parse --verify --end-of-options "${REF}^{commit}"', self.source)
        self.assertIn('git archive --format=tar "$COMMIT"', self.source)
        self.assertIn('mv "$stage/ha-app/config.yaml" "$stage/config.yaml"', self.source)
        self.assertNotIn('cp ha-app/config.yaml', self.source)
        self.assertIn('git log -1 --format=%s "$COMMIT"', self.source)

    def test_ssh_requires_known_host_and_staging_respects_tmpdir(self):
        self.assertIn('-o StrictHostKeyChecking=yes', self.source)
        self.assertIn('"${TMPDIR:-/tmp}/lightesota-deploy.XXXXXX"', self.source)
        self.assertNotRegex(self.source, r'(StrictHostKeyChecking=(?:no|accept-new)|UserKnownHostsFile=/dev/null)')

    def test_previous_source_is_preserved_outside_supervisor_scan_root(self):
        self.assertIn('app=/local_apps/lightesota', self.source)
        self.assertIn('/share/lightesota-deployments/previous-source.XXXXXX', self.source)
        self.assertIn('mv "$app" "$backup/source"', self.source)
        self.assertIn('mv "$backup/source" "$app"', self.source)
        extract = self.source.index('tar -x --no-same-owner --no-same-permissions -C "$incoming"')
        backup = self.source.index('mv "$app" "$backup/source"')
        self.assertLess(extract, backup)
        self.assertNotRegex(self.source, r'rm\s+-rf\s+["\']?\$(?:APP|app)(?:["\']?\s|$)')

    def test_seed_checks_entire_data_directory_and_does_not_hide_failures(self):
        self.assertIn('if [ -e "$data" ] || [ -L "$data" ]; then', self.source)
        self.assertNotIn('/share/lightesota/settings.json', self.source)
        self.assertNotRegex(self.source, r'if "\$\{SSH\[@\]\}" .*\[ -e')
        self.assertIn('mkdir "$data"', self.source)
        self.assertNotIn('|| true', self.source)


if __name__ == "__main__":
    unittest.main()
