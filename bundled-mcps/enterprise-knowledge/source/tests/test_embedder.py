"""Tests for embedder.py — Ollama-only embedding provider.

Run from the bundle directory:
    uv pip install pytest
    python -m pytest tests/test_embedder.py -v
"""

import os
import sys
from unittest import mock

import pytest

# Add src to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))


class TestEmbedderLogic:
    """Test load_embedder() factory behavior without heavy LlamaIndex imports."""

    def test_embed_dims_has_nomic_at_768(self):
        """nomic-embed-text is configured at 768 dimensions."""
        from customer_ek_mcp import embedder

        assert embedder._embed_dim("ollama", "nomic-embed-text") == 768

    def test_unknown_model_raises(self):
        """Unknown model raises with helpful message."""
        from customer_ek_mcp import embedder

        with pytest.raises(RuntimeError) as exc_info:
            embedder._embed_dim("ollama", "unknown-model")

        assert "unknown embedding dimension" in str(exc_info.value)
        assert "EMBED_DIMS" in str(exc_info.value)

    def test_refuses_local_with_migration_hint(self):
        """EK_EMBEDDER=local produces a migration-hint error."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {"EK_EMBEDDER": "local"}, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                embedder.load_embedder()

            error_msg = str(exc_info.value)
            assert "was removed" in error_msg
            assert "Ollama" in error_msg
            assert "sources_refresh(force=true)" in error_msg

    def test_refuses_openai_with_migration_hint(self):
        """EK_EMBEDDER=openai produces a migration-hint error."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {"EK_EMBEDDER": "openai"}, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                embedder.load_embedder()

            assert "was removed" in str(exc_info.value)

    def test_refuses_azure_openai_with_migration_hint(self):
        """EK_EMBEDDER=azure_openai produces a migration-hint error."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {"EK_EMBEDDER": "azure_openai"}, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                embedder.load_embedder()

            assert "was removed" in str(exc_info.value)

    def test_refuses_unknown_provider(self):
        """Unknown EK_EMBEDDER value raises a clear error."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {"EK_EMBEDDER": "voyage"}, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                embedder.load_embedder()

            error_msg = str(exc_info.value)
            assert "unknown EK_EMBEDDER" in error_msg
            assert "ollama" in error_msg

    def test_default_is_ollama_unset_env(self):
        """Default provider is ollama when EK_EMBEDDER is not set."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {}, clear=True):
            # Mock OllamaEmbedding to avoid importing the full LlamaIndex stack
            with mock.patch("llama_index.embeddings.ollama.OllamaEmbedding") as mock_cls:
                mock_instance = mock.MagicMock()
                mock_cls.return_value = mock_instance

                result = embedder.load_embedder()

                mock_cls.assert_called_once()
                assert result.signature == "ollama:nomic-embed-text"
                assert result.embed_dim == 768

    def test_ollama_uses_custom_model_from_env(self):
        """EK_OLLAMA_MODEL overrides the default model."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(
            os.environ, {"EK_EMBEDDER": "ollama", "EK_OLLAMA_MODEL": "mxbai-embed-large"}, clear=True
        ):
            # This should fail because mxbai-embed-large is not in EMBED_DIMS
            with pytest.raises(RuntimeError) as exc_info:
                embedder.load_embedder()

            assert "unknown embedding dimension" in str(exc_info.value)


class TestOllamaFactory:
    """Test the _ollama_load factory function."""

    def test_uses_default_url_when_env_unset(self):
        """Default OLLAMA_URL is http://embedding:11434."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {}, clear=True):
            with mock.patch("llama_index.embeddings.ollama.OllamaEmbedding") as mock_cls:
                mock_instance = mock.MagicMock()
                mock_cls.return_value = mock_instance

                result = embedder._load_ollama()

                assert result.signature == "ollama:nomic-embed-text"
                assert result.embed_dim == 768
                mock_cls.assert_called_once_with(
                    model_name="nomic-embed-text",
                    base_url="http://embedding:11434",
                )

    def test_uses_custom_url_from_env(self):
        """OLLAMA_URL overrides the default base URL."""
        from customer_ek_mcp import embedder

        env = {"OLLAMA_URL": "http://my-ollama:9090"}
        with mock.patch.dict(os.environ, env, clear=True):
            with mock.patch("llama_index.embeddings.ollama.OllamaEmbedding") as mock_cls:
                mock_cls.return_value = mock.MagicMock()

                embedder._load_ollama()

                mock_cls.assert_called_once_with(
                    model_name="nomic-embed-text",
                    base_url="http://my-ollama:9090",
                )

    def test_strips_trailing_slash_from_url(self):
        """OLLAMA_URL with trailing slash is cleaned."""
        from customer_ek_mcp import embedder

        with mock.patch.dict(os.environ, {"OLLAMA_URL": "http://ollama:11434/"}, clear=True):
            with mock.patch("llama_index.embeddings.ollama.OllamaEmbedding") as mock_cls:
                mock_cls.return_value = mock.MagicMock()

                embedder._load_ollama()

                mock_cls.assert_called_once_with(
                    model_name="nomic-embed-text",
                    base_url="http://ollama:11434",  # no trailing slash
                )

    def test_uses_custom_model_from_env(self):
        """EK_OLLAMA_MODEL overrides the default model name."""
        from customer_ek_mcp import embedder

        env = {"EK_OLLAMA_MODEL": "different-model"}
        # This will fail at _embed_dim (not in EMBED_DIMS), but we just want to verify
        # the model name is read from env
        with mock.patch.dict(os.environ, env, clear=True):
            with pytest.raises(RuntimeError) as exc_info:
                embedder._load_ollama()

            # Should have tried to look up "different-model" in EMBED_DIMS
            assert "different-model" in str(exc_info.value)
