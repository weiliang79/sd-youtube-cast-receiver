import asyncio
import importlib.util
import io
from pathlib import Path
import re
import unittest
from unittest.mock import AsyncMock, Mock, patch

SPEC = importlib.util.spec_from_file_location("plugin_main", Path(__file__).parents[2] / "main.py")
plugin_main = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin_main)


class ApiCapabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_per_launch_rotation_rpc_delivery_and_unload_invalidation(self):
        plugin = plugin_main.Plugin()
        with self.assertRaises(RuntimeError):
            await plugin.get_api_token()

        def process(*args, **kwargs):
            return Mock(stdout=io.BytesIO(b"READY\n"), stderr=io.BytesIO(), poll=Mock(return_value=None))

        with patch.object(plugin_main, "_stage_runtime_binaries"), \
             patch.object(plugin_main.subprocess, "Popen", side_effect=process) as popen, \
             patch.object(plugin_main, "logger") as logger:
            await plugin._main()
            first = await plugin.get_api_token()
            self.assertTrue(re.fullmatch(r"[A-Za-z0-9_-]{43,}", first))
            self.assertEqual(popen.call_args.kwargs["env"]["YTCAST_API_TOKEN"], first)
            self.assertNotIn(first, str(popen.call_args.args))
            await plugin._main()
            second = await plugin.get_api_token()
            self.assertNotEqual(first, second)
            self.assertNotIn(first, str(logger.mock_calls))
            self.assertNotIn(second, str(logger.mock_calls))
            plugin.node_process.poll.return_value = 1
            with self.assertRaises(RuntimeError):
                await plugin.get_api_token()
            plugin.node_process.poll.return_value = None
            with patch.object(plugin, "_terminate_process_group", new_callable=AsyncMock):
                await plugin._unload()
            with self.assertRaises(RuntimeError):
                await plugin.get_api_token()
            await asyncio.sleep(0)

    async def test_launch_failure_does_not_leave_a_bootstrap_capability(self):
        plugin = plugin_main.Plugin()
        with patch.object(plugin_main, "_stage_runtime_binaries"), \
             patch.object(plugin_main.subprocess, "Popen", side_effect=OSError("launch failed")), \
             patch.object(plugin_main, "logger"):
            await plugin._main()
        with self.assertRaises(RuntimeError):
            await plugin.get_api_token()


if __name__ == "__main__":
    unittest.main()
