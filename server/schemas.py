"""VISTA shared Pydantic schemas — mirrors shared/*.json. Extension must conform."""
from typing import Any, Optional
from pydantic import BaseModel, Field


class PlanRequest(BaseModel):
    goal: str = Field(max_length=2000)
    url_host: str = ''
    semantic_dom: list[dict[str, Any]] = []
    screenshot_redacted_b64: Optional[str] = None
    redaction_manifest: list[dict[str, Any]] = []
    mode: str = 'dom'  # 'dom' | 'vision'
    # Outcome of the previous step (action, acted, page_changed, actError).
    # Lets the planner break no-effect loops instead of repeating them.
    # Contains no page content or input values — safe under the privacy invariant.
    last_step: Optional[dict[str, Any]] = None
    # True once the extension's local clipboard holds copied text (flag only —
    # the text itself never leaves the browser).
    clipboard_filled: bool = False


class PlanResponse(BaseModel):
    thought: str = ''
    action: str = 'done'  # click|type|select|scroll|press|navigate|copy|paste|done
    targetId: Optional[str] = None
    fallback_xy: Optional[list[int]] = None
    value: Optional[str] = None
    direction: Optional[str] = None
    pixels: Optional[int] = None
    key: Optional[str] = None
    done: bool = False
    need_vision: bool = False
    # Phase 2 provenance (optional; extension ignores unknown fields safely).
    planner: str = 'heuristic'
    fallback_reason: Optional[str] = None
