"""Portal Usage — backend for the desktop status-bar chip.

Aggregates usage limits and remaining budget for the three billing portals this
machine is configured against:

* **OpenCode Go** — the provider profile's ``fetch_account_usage`` hook
  (``/zen/go/v1/usage``: rolling / weekly / monthly percent windows).
* **OpenRouter**  — the built-in credits + key fetcher.
* **Nous Portal** — the OAuth portal account.

Every fetch goes through Hermes's own code, so credential resolution (env,
credential pool, OAuth refresh) stays in exactly one place. Nothing in this
module reads, logs, or returns a credential.
"""

from __future__ import annotations

import logging
import math
import re
import threading
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional

from fastapi import APIRouter

log = logging.getLogger(__name__)

router = APIRouter()

# A portal fetch is one HTTP round trip; the OpenRouter numbers are cached
# server-side for ~60s anyway, so polling faster buys nothing.
_CACHE_TTL_S = 60.0

_lock = threading.Lock()
_cache: dict[str, Any] = {"at": 0.0, "payload": None}

_MONEY_RE = re.compile(r"\$([\d,]+(?:\.\d+)?)")
_PAIR_RE = re.compile(r"\$([\d,]+(?:\.\d+)?)\s+of\s+\$([\d,]+(?:\.\d+)?)")


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _num(value: Any) -> Optional[float]:
    """Finite float or None — never NaN/Inf, never a string."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, Decimal):
        value = float(value)
    if not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _money(text: Any) -> Optional[float]:
    match = _MONEY_RE.search(str(text or ""))
    if not match:
        return None
    try:
        return float(match.group(1).replace(",", ""))
    except ValueError:
        return None


def _money_pair(text: Any) -> tuple[Optional[float], Optional[float]]:
    """'$20.00 of $20.00 remaining …' → (limit=20.0, remaining=20.0)."""
    match = _PAIR_RE.search(str(text or ""))
    if not match:
        return None, None
    try:
        return float(match.group(2).replace(",", "")), float(match.group(1).replace(",", ""))
    except ValueError:
        return None, None


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if value is None:
        return None
    return str(value)


def _windows(snapshot: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for window in getattr(snapshot, "windows", ()) or ():
        used = _num(getattr(window, "used_percent", None))
        label = str(getattr(window, "label", "") or "")
        if label in ("Rolling window", "Weekly", "Monthly", "API key quota", "Subscription"):
            label = f"{label} "
        out.append({
            "label": label,
            "used_percent": used,
            "remaining_percent": None if used is None else max(0.0, min(100.0, 100.0 - used)),
            "reset_at": _iso(getattr(window, "reset_at", None)),
            "detail": getattr(window, "detail", None) or None,
        })
    return out


def _portal(pid: str, label: str) -> dict[str, Any]:
    return {
        "id": pid, "label": label, "ok": False, "error": None,
        "plan": None, "source": None, "fetched_at": None,
        "windows": [], "details": [],
        "money": {"balance_usd": None, "limit_usd": None, "remaining_usd": None,
                  "total_usable_usd": None},
    }


# --------------------------------------------------------------------------- #
# per-portal collectors
# --------------------------------------------------------------------------- #

def _collect_opencode_go() -> dict[str, Any]:
    from agent.account_usage import fetch_account_usage

    portal = _portal("opencode-go", "OpenCode Go")
    snapshot = fetch_account_usage("opencode-go")
    if snapshot is None:
        # No hook result => no credential for this provider, or the relay refused.
        portal["error"] = "No response from the OpenCode Go usage endpoint."
        return portal

    portal["ok"] = True
    portal["plan"] = getattr(snapshot, "plan", None)
    portal["source"] = getattr(snapshot, "source", None)
    portal["fetched_at"] = _iso(getattr(snapshot, "fetched_at", None))
    portal["windows"] = _windows(snapshot)
    portal["details"] = [str(line) for line in (getattr(snapshot, "details", ()) or ())]
    return portal


def _collect_openrouter() -> dict[str, Any]:
    from agent.account_usage import fetch_account_usage

    portal = _portal("openrouter", "OpenRouter")
    snapshot = fetch_account_usage("openrouter")
    if snapshot is None:
        portal["error"] = "No response from the OpenRouter credits/key endpoints."
        return portal

    portal["ok"] = True
    portal["plan"] = getattr(snapshot, "plan", None)
    portal["source"] = getattr(snapshot, "source", None)
    portal["fetched_at"] = _iso(getattr(snapshot, "fetched_at", None))
    # Filter out API key quota window for OpenRouter
    portal["windows"] = [w for w in _windows(snapshot) if "api key quota" not in w.get("label", "").lower()]
    portal["details"] = [str(line) for line in (getattr(snapshot, "details", ()) or ())]

    # "Credits balance: $97.36" is the account runway.
    balance = next((_money(line) for line in portal["details"] if "balance" in line.lower()), None)
    portal["money"]["balance_usd"] = balance
    return portal


def _collect_nous() -> dict[str, Any]:
    from hermes_cli.nous_account import get_nous_portal_account_info

    portal = _portal("nous", "Nous Portal")
    info = get_nous_portal_account_info(force_fresh=True)
    if info is None or not getattr(info, "logged_in", False):
        portal["error"] = "Not signed in to the Nous Portal."
        return portal

    portal["ok"] = True
    portal["source"] = "portal-account"
    portal["fetched_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    sub = getattr(info, "subscription", None)
    access = getattr(info, "paid_service_access_info", None)
    if sub is not None:
        portal["plan"] = getattr(sub, "plan", None)
        cap = _num(getattr(sub, "monthly_credits", None))
        remaining = _num(getattr(sub, "credits_remaining", None))
        if cap and cap > 0 and remaining is not None:
            used = max(0.0, min(100.0, (cap - remaining) / cap * 100.0))
            portal["windows"].append({
                "label": "Subscription ",
                "used_percent": used,
                "remaining_percent": max(0.0, 100.0 - used),
                "reset_at": _iso(getattr(sub, "current_period_end", None)),
                "detail": f"${remaining:.2f} of ${cap:.2f} left",
            })
        portal["money"]["limit_usd"] = cap
        portal["money"]["remaining_usd"] = remaining
        rollover = _num(getattr(sub, "rollover_credits", None))
        if rollover:
            portal["details"].append(f"Rollover: ${rollover:.2f}")
        period_end = getattr(sub, "current_period_end", None)
        if period_end:
            portal["details"].append(f"Renews: {period_end}")
    if access is not None:
        sub_credits = _num(getattr(access, "subscription_credits_remaining", None))
        for attr, label in (("subscription_credits_remaining", "Subscription credits"),
                            ("purchased_credits_remaining", "Top-up credits"),
                            ("total_usable_credits", "Total usable")):
            value = _num(getattr(access, attr, None))
            if value is not None:
                portal["details"].append(f"{label}: ${value:.2f}")
        portal["money"]["total_usable_usd"] = _num(getattr(access, "total_usable_credits", None))
        if sub_credits is not None and sub_credits >= 50.0:
            portal["rollover_active"] = True
            for w in portal["windows"]:
                if "subscription" in w.get("label", "").lower():
                    w["rollover_active"] = True
    if getattr(info, "paid_service_access", None) is False:
        portal["details"].append("Paid service access is currently disabled.")

    return portal


_ORDER: tuple[tuple[str, str, Any], ...] = (
    ("opencode-go", "OpenCode Go", _collect_opencode_go),
    ("openrouter", "OpenRouter", _collect_openrouter),
    ("nous", "Nous Portal", _collect_nous),
)


def _build() -> dict[str, Any]:
    portals: list[dict[str, Any]] = []
    for pid, label, collector in _ORDER:
        try:
            portals.append(collector())
        except Exception as exc:  # noqa: BLE001 — one dead portal never blanks the panel
            log.debug("portal-usage: %s collector failed", pid, exc_info=True)
            portal = _portal(pid, label)
            portal["error"] = f"{type(exc).__name__}: {exc}"[:300]
            portals.append(portal)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "portals": portals,
    }


@router.get("/usage")
def usage(refresh: int = 0) -> dict[str, Any]:
    """Usage limits + remaining budget for every configured portal.

    Served from a 60s cache so the chip and the panel cannot stampede the
    upstream APIs; ``?refresh=1`` forces a re-read.
    """
    now = time.monotonic()
    with _lock:
        fresh = _cache["payload"] is not None and (now - _cache["at"]) < _CACHE_TTL_S
        if fresh and not refresh:
            return _cache["payload"]

    payload = _build()

    with _lock:
        _cache["at"] = now
        _cache["payload"] = payload
    return payload
