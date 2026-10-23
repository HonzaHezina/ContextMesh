"""AM-004: the map viewer is a locked-down static shell over the authenticated API."""

import re
import shutil
import subprocess
from pathlib import Path

import pytest

UI = Path(__file__).resolve().parents[1] / "src" / "active_memory" / "ui"


def test_ui_shell_is_served_with_strict_headers_and_no_data(app):
    from fastapi.testclient import TestClient

    with TestClient(app) as anonymous:  # the shell needs no token: it carries no memory data
        for path, kind in (
            ("/ui", "text/html"),
            ("/ui/app.js", "javascript"),
            ("/ui/logic.js", "javascript"),
            ("/ui/app.css", "text/css"),
            ("/ui/review", "text/html"),
            ("/ui/review.js", "javascript"),
            ("/ui/review_logic.js", "javascript"),
            ("/ui/shell.js", "javascript"),
            ("/ui/conv.js", "javascript"),
            ("/ui/timeline.js", "javascript"),
            ("/ui/graph.js", "javascript"),
            ("/ui/settings.js", "javascript"),
            ("/ui/paste.js", "javascript"),
            ("/ui/paste_logic.js", "javascript"),
            ("/ui/graph_logic.js", "javascript"),
            ("/ui/cytoscape.min.js", "javascript"),
            ("/ui/graph3d.js", "javascript"),
            ("/ui/3d-force-graph.min.js", "javascript"),
        ):
            response = anonymous.get(path)
            assert response.status_code == 200 and kind in response.headers["content-type"]
            csp = response.headers["content-security-policy"]
            assert "default-src 'none'" in csp and "script-src 'self'" in csp
            assert "unsafe-inline" not in csp and "unsafe-eval" not in csp
            assert "frame-ancestors 'none'" in csp
            assert response.headers["x-content-type-options"] == "nosniff"
            assert response.headers["cache-control"] == "no-store"
        # Data stays behind auth; the shell never embeds any.
        assert anonymous.get("/v1/map").status_code == 401
        assert "nodes" not in anonymous.get("/ui").text.lower().replace("uzlů", "")
        for path in (
            "/ui/../pyproject.toml",
            "/ui/secret.txt",
            "/ui/%2e%2e/api.py",
            "/ui/__init__.py",
        ):
            assert anonymous.get(path).status_code == 404


def test_ui_has_no_inline_scripts_external_resources_or_html_injection_sinks():
    for page in ("index.html",):
        html = (UI / page).read_text(encoding="utf-8")
        assert not re.search(r"<script(?![^>]*[ ]src=)", html) and "onclick=" not in html
        assert not re.search(r"(?:src|href)=[\"']https?:", html)
    # Our own code only; the vendored MIT library (cytoscape.min.js) is pinned and licensed.
    code = "".join(
        p.read_text(encoding="utf-8")
        for p in sorted(UI.glob("*.js"))
        if p.name not in ("cytoscape.min.js", "3d-force-graph.min.js")
    )
    for sink in (
        "innerHTML",
        "outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "new Function",
        "localStorage",
        "document.cookie",
        "location.",
    ):
        assert sink not in code, sink
    assert "https://" not in code and "http://" not in code
    # The token may be kept in this tab's sessionStorage (reload keeps the connection), by the shell only.
    others = "".join(
        p.read_text(encoding="utf-8")
        for p in sorted(UI.glob("*.js"))
        if p.name not in ("cytoscape.min.js", "3d-force-graph.min.js", "shell.js")
    )
    assert "sessionStorage" not in others


def test_ui_marks_candidates_and_never_auto_confirms():
    code = (UI / "app.js").read_text(encoding="utf-8")
    assert "Kandidát: strojový návrh" in code and "badge(node.status)" in code
    # The only writes are explicit reviews/proposal generation issued from button clicks.
    assert set(re.findall(r'call\("(POST|DELETE|PUT|PATCH)"', code)) == {"POST"}
    assert (
        code.count('call("POST"') == 2 and "/review" in code and "/v1/maintenance/propose" in code
    )
    css = (UI / "app.css").read_text(encoding="utf-8")
    assert ".candidate" in css and "dashed" in css


@pytest.mark.skipif(shutil.which("node") is None, reason="node is needed for the UI logic tests")
def test_ui_logic_unit_tests_pass():
    root = Path(__file__).resolve().parent
    result = subprocess.run(
        ["node", "--test", *map(str, sorted((root / "ui").glob("*.test.js")))],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-1000:]


def test_review_page_only_decides_through_the_review_endpoints_and_keeps_token_in_memory():
    code = (UI / "review.js").read_text(encoding="utf-8")
    assert set(re.findall(r'call\("(POST|PUT|PATCH|DELETE)"', code)) == {"POST"}
    assert code.count('call("POST"') == 2 and "/review" in code  # decide + start advice run
    assert '"/v1/recommendations/run"' in code and "/v1/recommendations/run" not in code.replace(
        '"/v1/recommendations/run"', ""
    )
    assert "?token" not in code and "token=" not in code and "history." not in code
    assert "expected_status" in code and "verifyDecision" in code  # conflicts + fresh-read check
    assert "disabled: !decision.allowed || busy" in code  # blocked while a request runs
    assert "Odpojit" in (UI / "index.html").read_text(encoding="utf-8")


def test_all_views_share_one_page_so_the_token_survives_navigation():
    html = (UI / "index.html").read_text(encoding="utf-8")
    assert html.count('id="connect"') == 1  # one connect form for every view
    for view in (
        "review",
        "conversations",
        "graph",
        "map",
        "timeline",
        "paste",
        "settings",
        "help",
    ):
        assert f'<section data-view="{view}"' in html  # the section itself, not just a menu button
    # Views never navigate away: no links between pages, so nothing forces a reconnect.
    assert "<a " not in html
    for name in (
        "app.js",
        "review.js",
        "conv.js",
        "timeline.js",
        "graph.js",
        "settings.js",
        "paste.js",
    ):
        code = (UI / name).read_text(encoding="utf-8")
        assert "fetch(" not in code and 'getElementById("token")' not in code, name


def test_vendored_graph_library_is_pinned_licensed_and_not_loaded_from_a_cdn():
    html = (UI / "index.html").read_text(encoding="utf-8")
    assert 'src="/ui/cytoscape.min.js"' in html and "cdn" not in html
    assert "MIT" in (UI / "cytoscape.LICENSE").read_text(encoding="utf-8")
    library = (UI / "cytoscape.min.js").read_text(encoding="utf-8")
    assert "Cytoscape Consortium" in library and "eval(" not in library
    assert "new Function" not in library  # works under script-src 'self' without unsafe-eval


def test_3d_graph_library_is_vendored_licensed_and_uses_no_eval_engine_or_html_tooltip():
    html = (UI / "index.html").read_text(encoding="utf-8")
    assert 'src="/ui/3d-force-graph.min.js"' in html and "cdn" not in html
    assert html.index("3d-force-graph.min.js") < html.index("graph3d.js") < html.index("graph.js")
    assert "MIT" in (UI / "3d-force-graph.LICENSE").read_text(encoding="utf-8")
    assert (
        (UI / "3d-force-graph.min.js")
        .read_text(encoding="utf-8")
        .startswith("// Version 1.80.1 3d-force-graph")
    )
    library = (UI / "3d-force-graph.min.js").read_text(encoding="utf-8")
    # Its three inline <style> injections are disabled (the CSP refuses them); the rules live in app.css.
    assert "typeof document){var i=document.head" not in library
    assert ".float-tooltip-kap" in (UI / "app.css").read_text(encoding="utf-8")
    code = (UI / "graph3d.js").read_text(encoding="utf-8")
    # The bundle also contains the ngraph engine, which compiles code with `new Function` and would be
    # refused by our CSP. It is never selected; the default d3 engine needs no eval.
    assert "forceEngine" not in code
    # The library's tooltip inserts HTML, so it is switched off and labels are set as text.
    assert 'nodeLabel(() => "")' in code and 'linkLabel(() => "")' in code
    assert "textContent = n.label" in code


def test_settings_page_never_prefills_or_stores_secrets_and_changes_only_through_the_api():
    code = (UI / "settings.js").read_text(encoding="utf-8")
    assert set(re.findall(r'call\("(POST|PUT|PATCH|DELETE)"', code)) == {"POST", "PUT"}
    assert '"/v1/settings/llm"' in code and '"/v1/settings/llm/test"' in code
    # keys are cleared after every load and never copied from the server's answer
    assert 'value = ""' in code and "api_key.value =" not in code.replace(
        '$("s-model_api_key").value = ""', ""
    )
    html = (UI / "index.html").read_text(encoding="utf-8")
    assert html.count('type="password"') == 3  # token + two write-only keys
