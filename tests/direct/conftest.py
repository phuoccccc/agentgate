"""Small Windows compatibility patch for the current Direct Mode runner.

The upstream runner replaces file descriptor 0 with a temporary file and then
immediately unlinks that file. POSIX permits this, but Windows raises WinError 32
until stdin is restored. Keep the path and remove it during normal VM cleanup.
"""

import os
import tempfile

from gltest.direct import loader, wasi_mock
from gltest.direct.vm import VMContext


if os.name == "nt":
    def _inject_message_to_fd0_windows(vm):
        try:
            calldata = loader.import_calldata()
            Address = loader.import_address()
        except ImportError:
            return

        sender = vm.sender
        if isinstance(sender, bytes):
            sender = Address(sender)

        contract_address = vm._contract_address
        if isinstance(contract_address, bytes):
            contract_address = Address(contract_address)

        origin = vm.origin
        if isinstance(origin, bytes):
            origin = Address(origin)

        encoded = calldata.encode(
            {
                "contract_address": contract_address,
                "sender_address": sender,
                "origin_address": origin,
                "stack": [],
                "value": vm._value,
                "datetime": vm._datetime,
                "is_init": False,
                "chain_id": vm._chain_id,
                "entry_kind": 0,
                "entry_data": b"",
                "entry_stage_data": None,
            }
        )

        fd, path = tempfile.mkstemp()
        try:
            os.write(fd, encoded)
            os.lseek(fd, 0, os.SEEK_SET)
            vm._original_stdin_fd = os.dup(0)
            os.dup2(fd, 0)
            vm._agentgate_stdin_temp_path = path
        finally:
            os.close(fd)

    _original_cleanup = VMContext._cleanup_after_deactivate

    def _cleanup_after_deactivate_windows(self):
        path = getattr(self, "_agentgate_stdin_temp_path", None)
        _original_cleanup(self)
        if path is not None:
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            self._agentgate_stdin_temp_path = None

    loader._inject_message_to_fd0 = _inject_message_to_fd0_windows
    VMContext._cleanup_after_deactivate = _cleanup_after_deactivate_windows


def _handle_llm_request_v03(vm, data):
    """Keep mocked JSON as text so the v0.3 SDK decodes it exactly once."""
    prompt = data.get("prompt", "")
    response = vm._match_llm_mock(prompt)
    if response is not None:
        return {"ok": response}

    live_handler = getattr(vm, "_live_llm_handler", None)
    if live_handler is not None:
        return live_handler(data)

    registered = [pattern.pattern for pattern, _ in vm._llm_mocks]
    raise wasi_mock.MockNotFoundError(
        f"No LLM mock for prompt: {prompt[:100]}...\n"
        f"  Registered: {registered or '(none)'}"
    )


wasi_mock._handle_llm_request = _handle_llm_request_v03
