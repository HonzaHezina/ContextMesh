"""Generate synthetic test conversations in the shapes users can paste or import.

Writes examples/test-conversations/: plain-text copies (speaker markers of ChatGPT, Claude, Gemini and
the Claude Code terminal) and JSON in the structure of the ChatGPT / claude.ai / Google Takeout data
exports and of the OpenAI, Anthropic and Gemini chat APIs. All content is invented. The JSON shapes
follow the known structure of those formats and are not verified against real exports.
Usage: python scripts/make_test_conversations.py
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "examples" / "test-conversations"

# (id, title, start, [(role, text)]) - themes recur across chats: lidská kontrola, spánek, zahrada.
CONVERSATIONS = [
    (
        "zahrada",
        "Plán zahrady",
        "2026-09-12T08:30:00+00:00",
        [
            (
                "user",
                "Chci na jaře předělat zahradu. Hlavně nechci, aby mi to zabralo každý víkend.",
            ),
            (
                "assistant",
                "Zvolte trvalky a mulčování: po prvním roce vyžadují minimum péče. Začněte jedním záhonem, ne celou zahradou.",
            ),
            (
                "user",
                "A co zavlažování? Nechci ho nechat úplně na automatice, chci mít poslední slovo.",
            ),
            (
                "assistant",
                "Kapková závlaha s časovačem a ručním přepínačem je dobrý kompromis: systém zalévá, ale vy můžete kdykoli zasáhnout.",
            ),
            ("user", "Dobře, tak záhon u plotu a kapková závlaha s ručním přepínačem."),
        ],
    ),
    (
        "spanek",
        "Spánek a práce",
        "2026-09-20T21:10:00+00:00",
        [
            ("user", "Poslední týdny spím špatně, protože do večera pracuji na projektu."),
            (
                "assistant",
                "Zkuste pevný konec práce alespoň dvě hodiny před spaním a krátký večerní rituál bez obrazovky.",
            ),
            ("user", "Nechci přísná pravidla, spíš jednoduchý zvyk, který udržím."),
            (
                "assistant",
                "Pak jen jedno pravidlo: v 21:00 zavřít notebook. Vše ostatní nechte volné.",
            ),
        ],
    ),
    (
        "automatizace",
        "Automatizace rozhodování",
        "2026-10-02T10:00:00+00:00",
        [
            ("user", "Při automatizaci rozhodování chci zachovat lidskou kontrolu."),
            (
                "assistant",
                "Rozlište doporučení a rozhodnutí: systém může navrhovat, ale schválení zůstává na člověku.",
            ),
            (
                "user",
                "Stejně to chci i u rezervací v ateliéru. Automat navrhne termín, já ho potvrdím.",
            ),
            (
                "assistant",
                "To je konzistentní přístup: návrh automaticky, potvrzení ručně, s možností vrátit zpět.",
            ),
            ("user", "Jak poznám, kdy můžu nechat rozhodnutí úplně na systému?"),
            (
                "assistant",
                "Když je chyba levná a vratná, například u řazení e-mailů. U peněz a závazků ne.",
            ),
        ],
    ),
]
LABEL = {"user": "Vy", "assistant": "Asistent"}
BOT = {"chatgpt": "ChatGPT", "claude": "Claude", "gemini": "Gemini"}


def times(start, n):
    t0 = datetime.fromisoformat(start)
    return [t0 + timedelta(minutes=2 * i) for i in range(n)]


def write(name, data):
    OUT.mkdir(parents=True, exist_ok=True)
    text = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, indent=2)
    (OUT / name).write_text(text + "\n", encoding="utf-8")


def plain():
    for cid, title, _, msgs in CONVERSATIONS:
        for vendor, bot in BOT.items():
            if vendor == "chatgpt":  # "You said:" / "ChatGPT said:" with the text on the next line
                body = "\n\n".join(
                    f"{'You said:' if r == 'user' else 'ChatGPT said:'}\n{t}" for r, t in msgs
                )
            else:
                body = "\n\n".join(f"{'Vy' if r == 'user' else bot}: {t}" for r, t in msgs)
            write(f"text-{vendor}-{cid}.txt", body)
        write(
            f"text-claude-code-{cid}.txt",
            "\n\n".join(f"> {t}" if r == "user" else f"● {t}" for r, t in msgs),
        )
        # No markers at all: paragraphs only, the person assigns the speakers by hand.
        write(f"text-bez-znacek-{cid}.txt", "\n\n".join(t for _, t in msgs))


def chatgpt():
    out = []
    for cid, title, start, msgs in CONVERSATIONS:
        mapping, parent = (
            {"root": {"id": "root", "parent": None, "message": None, "children": []}},
            "root",
        )
        for i, ((role, text), when) in enumerate(zip(msgs, times(start, len(msgs)))):
            node = f"{cid}-n{i}"
            mapping[node] = {
                "id": node,
                "parent": parent,
                "children": [],
                "message": {
                    "id": node,
                    "author": {"role": role},
                    "create_time": when.timestamp(),
                    "content": {"content_type": "text", "parts": [text]},
                },
            }
            mapping[parent]["children"].append(node)
            parent = node
        # a system message and an abandoned branch, which the importer must skip
        mapping["sys"] = {
            "id": "sys",
            "parent": "root",
            "children": [],
            "message": {
                "id": "sys",
                "author": {"role": "system"},
                "create_time": None,
                "content": {"content_type": "text", "parts": [""]},
            },
        }
        out.append(
            {
                "id": f"chatgpt-{cid}",
                "conversation_id": f"chatgpt-{cid}",
                "title": title,
                "create_time": datetime.fromisoformat(start).timestamp(),
                "current_node": parent,
                "mapping": mapping,
            }
        )
    write("export-chatgpt-conversations.json", out)


def claude():
    out = []
    for cid, title, start, msgs in CONVERSATIONS:
        stamps = times(start, len(msgs))
        out.append(
            {
                "uuid": f"claude-{cid}",
                "name": title,
                "created_at": stamps[0].isoformat().replace("+00:00", "Z"),
                "chat_messages": [
                    {
                        "uuid": f"claude-{cid}-m{i}",
                        "sender": "human" if r == "user" else "assistant",
                        "text": t,
                        "content": [{"type": "text", "text": t}],
                        "created_at": s.isoformat().replace("+00:00", "Z"),
                    }
                    for i, ((r, t), s) in enumerate(zip(msgs, stamps))
                ],
            }
        )
    write("export-claude-conversations.json", out)


def gemini():
    entries = []
    for cid, title, start, msgs in CONVERSATIONS:
        for (r, user_text), (_, answer), when in zip(
            msgs[0::2], msgs[1::2], times(start, len(msgs))[0::2]
        ):
            entries.append(
                {
                    "header": "Gemini Apps",
                    "title": f"Prompted {user_text}",
                    "products": ["Gemini Apps"],
                    "time": when.isoformat().replace("+00:00", "Z"),
                    "safeHtmlItem": [{"html": f"<p>{answer}</p>"}],
                }
            )
    write(
        "export-gemini-takeout-MyActivity.json",
        sorted(entries, key=lambda e: e["time"], reverse=True),
    )


def apis():
    first = CONVERSATIONS[2][3]
    write(
        "api-openai-messages.json",
        {
            "messages": [{"role": "system", "content": "Odpovídej česky."}]
            + [{"role": r, "content": t} for r, t in first]
        },
    )
    write(
        "api-anthropic-messages.json",
        {
            "system": "Odpovídej česky.",
            "messages": [{"role": r, "content": [{"type": "text", "text": t}]} for r, t in first],
        },
    )
    write(
        "api-gemini-contents.json",
        {
            "contents": [
                {"role": "user" if r == "user" else "model", "parts": [{"text": t}]}
                for r, t in first
            ]
        },
    )


if __name__ == "__main__":
    plain(), chatgpt(), claude(), gemini(), apis()
    print(f"Written to {OUT}")
