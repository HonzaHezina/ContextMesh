import hashlib
import ipaddress
import json
import os
from pathlib import Path
from urllib.parse import urlparse

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Usual embedding model and dimension per provider host, used when none is set explicitly.
HOST_DEFAULTS = {
    "api.openai.com": ("text-embedding-3-small", 1536),
    "generativelanguage.googleapis.com": ("gemini-embedding-001", 3072),
    "api.mistral.ai": ("mistral-embed-2312", 1024),
}

# One-click provider choices shown in the UI. Model names come from the providers' documentation
# (checked 2026-10-13, OpenAI and the retry note 2026-10-23); the quality of any of them on Czech data has NOT been measured here.
PRESETS = [
    {
        "id": "gemini",
        "label": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "model": "gemini-3.5-flash-lite",
        "advice_model": "gemini-3.8-flash",
        "embedding_model": "gemini-embedding-001",
        "embedding_dim": 3072,
        "note": "Extrakce: nejlevnější rychlý model (Flash-Lite). Rady a posuzování vazeb: Flash. "
        "Embeddingy: textový model gemini-embedding-001. Rozhraní kompatibilní s OpenAI je u Googlu v beta stavu. "
        "Bezplatná úroveň může data používat ke zlepšování produktů Googlu; u placené úrovně ne.",
    },
    {
        "id": "mistral",
        "label": "Mistral",
        "base_url": "https://api.mistral.ai/v1",
        "model": "mistral-small-2603",
        "advice_model": "mistral-medium-3-5",
        "embedding_model": "mistral-embed-2312",
        "embedding_dim": 1024,
        "note": "Extrakce: Mistral Small 4 (levný, podporuje strukturovaný výstup). Rady a posuzování vazeb: Mistral Medium 3.5 "
        "(dražší, silnější). Embeddingy: mistral-embed. Rozměr 1024 vychází z běžně uváděné hodnoty, "
        "v načtené dokumentaci uveden nebyl. Bezplatná úroveň má nízký limit požadavků: při HTTP 429 aplikace zkusí volání "
        "znovu s odstupem (respektuje Retry-After), při trvalém 429 úlohu zopakuje později; pomůže pomalejší dávka nebo placená úroveň.",
    },
    {
        "id": "openai",
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-6-luna",
        "advice_model": "gpt-6.1-sol",
        "embedding_model": "text-embedding-3-small",
        "embedding_dim": 1536,
        "note": "Extrakce: GPT-6 Luna (nejlevnější, doporučená náhrada za gpt-4.1-mini, který OpenAI vypíná 2027-01-14). "
        "Rady a posuzování vazeb: GPT-6.1 Sol (dražší, silnější). Embeddingy: text-embedding-3-small. "
        "Podpora strukturovaného výstupu u těchto modelů v dokumentaci nepotvrzena; při odmítnutí se použije záložní JSON režim.",
    },
    {
        "id": "ollama",
        "label": "Lokální model (Ollama)",
        "base_url": "http://localhost:11434/v1",
        "model": "",
        "advice_model": "",
        "embedding_model": "",
        "embedding_dim": None,
        "note": "Běží na vašem počítači, nic se neodesílá. Názvy modelů zadejte podle toho, co máte stažené.",
    },
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="MEMORY_", extra="ignore", env_ignore_empty=True
    )
    scope: str = "personal:owner"
    backend: str = "reference"
    data_dir: Path = Path("data")
    clients_file: Path = Path("config/clients.json")
    api_key: str = ""  # single-owner fallback; use separate hashed client keys on deployment
    host: str = "127.0.0.1"
    port: int = 8080
    worker_enabled: bool = True
    poll_seconds: float = Field(default=1, ge=0.1)
    extraction_mode: str = "provided"
    allow_model_calls: bool = False
    graphiti_enabled: bool = False
    model_base_url: str = "https://api.openai.com/v1"
    model_api_key: str = ""
    model_name: str = "gpt-6-luna"
    # Embeddings default to the model provider (same address and key). Set these only to split them.
    embedding_base_url: str = ""
    embedding_api_key: str = ""
    embedding_model: str = ""  # empty: the provider's usual embedding model (HOST_DEFAULTS)
    embedding_dim: int | None = None
    # Model for advice and relation judging; empty means the same model as for extraction.
    advice_model: str = ""
    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = ""
    neo4j_database: str = "neo4j"
    # AM-003 link proposals. lexical = offline signals only; embedding adds provider vectors.
    similarity_mode: str = "lexical"
    proposal_threshold: float | None = Field(
        default=None, ge=0.1, le=1
    )  # 0.5 lexical, 0.6 embedding
    judge_enabled: bool = False
    max_judge_calls: int = Field(default=20, ge=0, le=500)
    auto_propose: bool = False
    recommend_enabled: bool = False
    max_recommend_calls: int = Field(default=50, ge=0, le=500)
    timeout_seconds: int = Field(default=120, ge=5, le=600)

    @model_validator(mode="after")
    def validate_configuration(self):
        if self.backend not in {"reference", "neo4j"}:
            raise ValueError("backend must be reference or neo4j")
        if self.extraction_mode not in {"provided", "llm"}:
            raise ValueError("extraction_mode must be provided or llm")
        if self.graphiti_enabled and self.backend != "neo4j":
            raise ValueError("Graphiti requires Neo4j")
        if (self.graphiti_enabled or self.extraction_mode == "llm") and not self.allow_model_calls:
            raise ValueError("explicit MEMORY_ALLOW_MODEL_CALLS=true required")
        if (self.graphiti_enabled or self.extraction_mode == "llm") and not self.model_api_key:
            raise ValueError("model_api_key required (local endpoints may use a placeholder)")
        if self.graphiti_enabled and not self.effective_embedding_api_key:
            raise ValueError("embedding_api_key required")
        if self.similarity_mode not in {"lexical", "embedding"}:
            raise ValueError("similarity_mode must be lexical or embedding")
        if (self.similarity_mode == "embedding" or self.judge_enabled) and not (
            self.allow_model_calls
        ):
            raise ValueError("explicit MEMORY_ALLOW_MODEL_CALLS=true required")
        if self.similarity_mode == "embedding" and not self.effective_embedding_api_key:
            raise ValueError(
                "an API key is required for embeddings (a separate embedding provider needs its own key)"
            )
        if (
            self.similarity_mode == "embedding" or self.graphiti_enabled
        ) and not self.effective_embedding_model:
            raise ValueError("embedding_model required: this provider has no known default")
        if self.judge_enabled and not self.model_api_key:
            raise ValueError("model_api_key required for the relation judge")
        if self.recommend_enabled and not self.allow_model_calls:
            raise ValueError("explicit MEMORY_ALLOW_MODEL_CALLS=true required")
        if self.recommend_enabled and not self.model_api_key:
            raise ValueError("model_api_key required for model recommendations")
        if self.backend == "neo4j" and not self.neo4j_password:
            raise ValueError("neo4j_password required")
        if not self.scope.startswith("personal:"):
            raise ValueError("v0.1 supports one personal scope per deployment")
        return self

    @property
    def effective_embedding_base_url(self):
        return self.embedding_base_url or self.model_base_url

    @property
    def effective_embedding_api_key(self):
        """The model key is lent to embeddings only when they go to the same provider host.

        A separate embedding address never receives the model's key.
        """
        if self.embedding_api_key:
            return self.embedding_api_key
        same_host = (
            urlparse(self.effective_embedding_base_url).hostname
            == urlparse(self.model_base_url).hostname
        )
        return self.model_api_key if same_host else ""

    @property
    def effective_embedding_model(self):
        if self.embedding_model:
            return self.embedding_model
        host = urlparse(self.effective_embedding_base_url).hostname
        return HOST_DEFAULTS.get(host, ("", None))[0]

    @property
    def effective_embedding_dim(self):
        if self.embedding_dim:
            return self.embedding_dim
        host = urlparse(self.effective_embedding_base_url).hostname
        return HOST_DEFAULTS.get(host, ("", None))[1] or 1536

    @property
    def effective_advice_model(self):
        return self.advice_model or self.model_name

    @property
    def effective_threshold(self):
        if self.proposal_threshold is not None:
            return self.proposal_threshold
        return 0.6 if self.similarity_mode == "embedding" else 0.5

    def clients(self):
        if self.clients_file.exists():
            clients = json.loads(self.clients_file.read_text())
        elif len(self.api_key) >= 24:
            clients = [
                {
                    "id": "owner",
                    "key_sha256": hashlib.sha256(self.api_key.encode()).hexdigest(),
                    "permissions": ["read", "write", "admin"],
                }
            ]
        else:
            raise ValueError("configure clients.json or a MEMORY_API_KEY of at least 24 characters")
        if not clients:
            raise ValueError("empty clients configuration")
        for client in clients:
            digest = client.get("key_sha256", "")
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("client keys must be SHA-256 hex hashes")
            if not set(client.get("permissions", [])) <= {"read", "write", "admin"}:
                raise ValueError("unknown client permission")
        return clients


# Fields an admin may change at runtime from the UI. Everything else (backend, scope, Neo4j,
# Graphiti, listening address) stays deployment configuration. Secrets are write-only.
RUNTIME_FIELDS = (
    "extraction_mode",
    "allow_model_calls",
    "model_base_url",
    "model_name",
    "model_api_key",
    "advice_model",
    "embedding_base_url",
    "embedding_model",
    "embedding_dim",
    "embedding_api_key",
    "similarity_mode",
    "judge_enabled",
    "max_judge_calls",
    "auto_propose",
    "recommend_enabled",
    "max_recommend_calls",
)
SECRET_FIELDS = ("model_api_key", "embedding_api_key")
OVERRIDE_FILE = "settings.override.json"


def check_endpoint(url):
    """Provider URLs must be http(s) with a host, no embedded credentials, not link-local."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("the provider address must be a full http(s) URL")
    if parsed.username or parsed.password:
        raise ValueError("do not put credentials into the provider address")
    try:
        if ipaddress.ip_address(parsed.hostname).is_link_local:
            raise ValueError("link-local addresses are not allowed as provider")
    except ValueError as error:
        if "link-local" in str(error):
            raise
    return url


def load_overrides(data_dir):
    path = Path(data_dir) / OVERRIDE_FILE
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if k in RUNTIME_FIELDS}


def save_overrides(data_dir, values):
    path = Path(data_dir) / OVERRIDE_FILE
    body = {k: values[k] for k in RUNTIME_FIELDS if k in values}
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)  # best effort; the data directory holds all memory anyway
    except OSError:
        pass
    os.replace(temporary, path)
