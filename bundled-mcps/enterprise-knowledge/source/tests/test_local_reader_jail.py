"""Unit tests for readers/local.py path jail."""

from __future__ import annotations

import os
import tempfile
import pytest
from pathlib import Path

from customer_ek_mcp.readers import local


def test_no_roots_refuses_all(monkeypatch):
    monkeypatch.setenv("EK_LOCAL_ROOTS", "")
    assert local._local_path("/etc/passwd") is None
    assert local._local_path("file:///etc/passwd") is None


def test_allowed_root_permits_subpath(monkeypatch):
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir).resolve()
        subfile = tmp_path / "foo.txt"
        subfile.write_text("hello")

        monkeypatch.setenv("EK_LOCAL_ROOTS", str(tmp_path))

        res = local._local_path(str(subfile))
        assert res == str(subfile)

        res_url = local._local_path(f"file://{subfile}")
        assert res_url == str(subfile)

        # Outside root refused
        assert local._local_path("/etc/passwd") is None


def test_traversal_and_symlink_escape_refused(monkeypatch):
    with tempfile.TemporaryDirectory() as root_dir, tempfile.TemporaryDirectory() as outside_dir:
        root_path = Path(root_dir).resolve()
        outside_path = Path(outside_dir).resolve()

        outside_file = outside_path / "secret.txt"
        outside_file.write_text("secret")

        # Symlink inside root pointing outside
        symlink_file = root_path / "link.txt"
        try:
            symlink_file.symlink_to(outside_file)
        except OSError:
            pytest.skip("symlinks not supported")

        monkeypatch.setenv("EK_LOCAL_ROOTS", str(root_path))

        # Direct traversal
        traversal = f"file://{root_path}/../{outside_path.name}/secret.txt"
        assert local._local_path(traversal) is None

        # Symlink escape
        assert local._local_path(str(symlink_file)) is None


def test_device_file_refused(monkeypatch):
    if not os.path.exists("/dev/zero"):
        pytest.skip("/dev/zero not present")

    monkeypatch.setenv("EK_LOCAL_ROOTS", "/dev")
    path = local._local_path("/dev/zero")
    assert path == "/dev/zero"

    with pytest.raises(ValueError, match="not a regular file or directory"):
        local.load("/dev/zero")
