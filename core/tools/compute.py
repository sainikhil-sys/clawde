"""Pure computation tools: a safe calculator and a JSON processor.

Neither can touch files, the network or code."""

from __future__ import annotations

import ast
import json
import math
import operator
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .base import Tool, ToolContext, ToolError, ToolResult, clip

_BIN: dict[type, Any] = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY: dict[type, Any] = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS: dict[str, Any] = {
    name: getattr(math, name)
    for name in (
        "sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "log", "log10", "log2", "exp", "floor",
        "ceil", "factorial", "gcd", "hypot", "radians", "degrees",
    )
} | {"abs": abs, "round": round, "min": min, "max": max}  # fmt: skip


def _factorial(n: Any) -> int:
    if not isinstance(n, int) or n < 0 or n > 1000:
        raise ToolError("factorial needs a whole number from 0 to 1000.")
    return math.factorial(n)


_FUNCS["factorial"] = _factorial
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}
MAX_POWER = 10_000
MAX_DIGITS = 4300


def evaluate(expression: str) -> float | int:
    """Evaluate arithmetic without `eval`: numbers, + - * / // % **, parentheses and whitelisted math."""
    if len(expression) > 500:
        raise ToolError("Expression is too long.")
    try:
        tree = ast.parse(expression.replace("^", "**"), mode="eval")
    except SyntaxError as exc:
        raise ToolError(f"Not a valid expression: {exc.msg}") from exc

    def ev(node: ast.AST) -> Any:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, (int, float))
            and not isinstance(node.value, bool)
        ):
            return node.value
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > MAX_POWER:
                raise ToolError("Exponent is too large.")
            return _BIN[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
            return _UNARY[type(node.op)](ev(node.operand))
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in _FUNCS
            and not node.keywords
        ):
            fn: Any = _FUNCS[node.func.id]
            return fn(*[ev(a) for a in node.args])
        raise ToolError(f"Unsupported expression element: {type(node).__name__}")

    try:
        result = ev(tree)
    except ToolError:
        raise
    except (ZeroDivisionError, OverflowError, ValueError, TypeError) as exc:
        raise ToolError(f"Can't compute that: {exc}") from exc
    if isinstance(result, int) and len(str(abs(result))) > MAX_DIGITS:
        raise ToolError("Result is too large to show.")
    return result  # type: ignore[no-any-return]


class CalcArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expression: str = Field(description="Arithmetic, e.g. (12.5 * 4) / 3 or sqrt(2) * pi")


async def _calc(_: ToolContext, args: CalcArgs) -> ToolResult:
    value = evaluate(args.expression)
    return ToolResult(output=f"{args.expression} = {value}", data={"value": value})


_PATH_TOKEN = re.compile(r"\.?([A-Za-z_][\w-]*)|\[(\d+)\]|\[\"([^\"]+)\"\]")


def query(data: Any, path: str) -> Any:
    """Follow a path like `items[0].name` or `["key with spaces"].x`."""
    pos = 0
    path = path.strip()
    if path.startswith("$"):
        path = path[1:]
    current = data
    while pos < len(path):
        m = _PATH_TOKEN.match(path, pos)
        if not m:
            raise ToolError(f'Can\'t parse path at {path[pos:]!r}. Use forms like a.b[0] or ["key"].')
        key, index, quoted = m.groups()
        try:
            if index is not None:
                current = current[int(index)]
            else:
                current = current[key if key is not None else quoted]
        except (KeyError, IndexError, TypeError) as exc:
            raise ToolError(f"Path {path[: m.end()]!r} doesn't exist in the data.") from exc
        pos = m.end()
    return current


class JsonArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    json_text: str = Field(description="The JSON document", max_length=500_000)
    operation: Literal["validate", "format", "query", "keys"] = "validate"
    path: str = Field(default="", description="For query: a path like items[0].name")


async def _json(_: ToolContext, args: JsonArgs) -> ToolResult:
    try:
        data = json.loads(args.json_text)
    except json.JSONDecodeError as exc:
        if args.operation == "validate":
            return ToolResult(output=f"Invalid JSON: {exc.msg} at line {exc.lineno}, column {exc.colno}.")
        raise ToolError(f"Invalid JSON: {exc.msg} at line {exc.lineno}, column {exc.colno}.") from exc
    if args.operation == "validate":
        kind = type(data).__name__.replace("dict", "object").replace("list", "array")
        size = f" with {len(data)} entries" if isinstance(data, (dict, list)) else ""
        return ToolResult(output=f"Valid JSON: {kind}{size}.")
    if args.operation == "format":
        return ToolResult(output=clip(json.dumps(data, indent=2, ensure_ascii=False)))
    if args.operation == "keys":
        target = query(data, args.path) if args.path else data
        if not isinstance(target, dict):
            raise ToolError("keys needs an object.")
        return ToolResult(output=", ".join(map(str, target.keys())) or "(no keys)")
    result = query(data, args.path)
    return ToolResult(output=clip(json.dumps(result, indent=2, ensure_ascii=False)))


CALCULATOR = Tool(
    name="calculator",
    description="Evaluate an arithmetic expression exactly (use this instead of doing math in your head).",
    risk="compute",
    args_model=CalcArgs,
    run=_calc,
)
JSON_TOOL = Tool(
    name="json",
    description="Validate, format, list keys of, or query a JSON document.",
    risk="compute",
    args_model=JsonArgs,
    run=_json,
)
