import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import tree_sitter_cpp
from tree_sitter import Language, Parser

PROFILES = Path(__file__).resolve().parent.parent / "profiles"
KERNEL = "DogSim.h"

LAWS = {
    "state-is-data": "Build the state from plain values only: numbers, enums, FVector-like structs, TArray/TOptional of values and project structs made of them. Refer to engine things by an id or index that the shell resolves.",
    "commands-are-data": "Make each command a plain record (an enum kind plus value fields) that Step interprets; never carry a function, pointer or handle in a command.",
    "step-is-pure": "Make Step (and Out) static or const, take inputs by value or const reference, create everything it writes locally, and compute only from its arguments: put time, random seeds and world facts into the state or the commands.",
    "log-is-append-only": "Keep the command log in a TDogLog<FCommand>, grow it only with Append and replay it with DogSeek.",
    "project-never-writes-back": "Step the sim and assign its state only inside a class marked DOG_SIM_SHELL; everything else reads the state and sends commands.",
    "project-is-a-function-of-state": "Make the shell's Project compute the screen only from its state argument, const members and the engine objects it writes to: put time, randomness and counters into the state (advanced by Step) or a TDogLayer the shell folds, never into shell fields, statics or engine clocks.",
    "is-pure": "A pure function computes only from its arguments: no clock, no randomness, no IO, no hidden state, no writes to anything it did not create.",
}

FIX = {
    "state-is-data": LAWS["state-is-data"],
    "commands-are-data": LAWS["commands-are-data"],
    "step-is-pure": LAWS["step-is-pure"],
    "log-is-append-only": LAWS["log-is-append-only"],
    "project-never-writes-back": LAWS["project-never-writes-back"],
    "project-is-a-function-of-state": LAWS["project-is-a-function-of-state"],
    "is-pure": "move the effect out: read the clock, the random draw or the world in the caller and pass what the function needs as arguments",
}

PROJECT = "Project"

CPP = Language(tree_sitter_cpp.language())


def load_profile(name_or_path):
    path = Path(name_or_path)
    if not path.suffix:
        path = PROFILES / f"{name_or_path}.json"
    profile = json.loads(path.read_bytes())
    return Profile(profile)


class Profile:
    def __init__(self, raw):
        self.raw = raw
        self.name = raw["name"]
        roots = raw.get("roots", {})
        self.interfaces = roots.get("interfaces", [])
        self.markers = roots.get("attributes", [])
        hidden = raw.get("hidden", {})
        self.clocks = tuple(hidden.get("clock", []))
        self.random_names = set(hidden.get("random", []))
        self.random_owners = set(hidden.get("randomOwners", []))
        self.world_owners = set(hidden.get("world", []))
        self.world_calls = set(hidden.get("worldCalls", []))
        self.heap_calls = set(hidden.get("heap", []))
        self.io_names = set(hidden.get("io", []))
        self.engine_global = re.compile(hidden.get("global", r"$^"))
        self.time_calls = set(hidden.get("timeCalls", []))
        self.time_fields = set(hidden.get("timeFields", []))
        data = raw.get("data", {})
        self.values = set(data.get("values", []))
        self.containers = set(data.get("containers", []))
        self.functions = set(data.get("functions", []))
        self.handles = set(data.get("handles", []))
        self.unordered = set(data.get("unordered", []))
        self.engine_object = re.compile(data.get("engineObjects", r"$^") if isinstance(data.get("engineObjects"), str) else (data.get("engineObjects") or [r"$^"])[0])
        log = raw.get("log", {})
        self.append_only = log.get("appendOnlyType", "")
        self.mutable_sequences = set(log.get("mutableSequences", []))
        shell = raw.get("shell", {})
        self.shell_marker = shell.get("marker", "")
        self.project_method = shell.get("projectMethod", PROJECT)
        scan = raw.get("scan", {})
        self.suffixes = set(scan.get("suffixes", [".h", ".hh", ".hpp", ".inl", ".cpp", ".cc", ".cxx"]))
        self.macro_calls = re.compile(scan.get("macroCalls", r"$^").encode())
        self.macro_words = re.compile(scan.get("macroWords", r"$^").encode())
        self.mutators = set(scan.get("mutators", []))
        self.object_pointers = set(scan.get("objectPointers", []))
        self.target_containers = set(scan.get("targetContainers", []))
        self.mutator_free = not self.interfaces and not self.shell_marker


def text(node):
    return node.text.decode("utf-8", "replace") if node is not None else ""


def squash(value):
    return " ".join(value.split())


TEMPLATE_ARGS = re.compile(r"<[^<>]*>")


def bare(value):
    value = squash(value)
    while TEMPLATE_ARGS.search(value):
        value = TEMPLATE_ARGS.sub("", value)
    value = re.sub(r"\b(?:class|struct|typename|enum)\s+", "", value).replace(" ", "")
    return value.lstrip(":")


def short(value):
    return bare(value).split("::")[-1]


def blank(buffer, start, end):
    for index in range(start, end):
        if buffer[index] not in (10, 13):
            buffer[index] = 32


def closing(source, start):
    depth = 0
    for index in range(start, min(len(source), start + 4000)):
        if source[index] == 40:
            depth += 1
        elif source[index] == 41:
            depth -= 1
            if depth == 0:
                return index + 1
    return start


def prepare(source, profile):
    buffer = bytearray(source)
    for match in profile.macro_calls.finditer(source):
        blank(buffer, match.start(), max(match.end(), closing(source, match.end() - 1)))
    for match in profile.macro_words.finditer(source):
        blank(buffer, match.start(), match.end())
    markers = []
    pure_markers = []

    def on_code_line(match):
        line = source[source.rfind(b"\n", 0, match.start()) + 1:match.start()]
        return not line.lstrip().startswith(b"#")

    if profile.shell_marker:
        for match in re.compile(rb"\b" + profile.shell_marker.encode() + rb"\b").finditer(source):
            if not on_code_line(match):
                continue
            markers.append(match.start())
            blank(buffer, match.start(), match.end())
    for marker in profile.markers:
        for match in re.compile(rb"\b" + marker.encode() + rb"\b").finditer(source):
            if not on_code_line(match):
                continue
            pure_markers.append(match.start())
            blank(buffer, match.start(), match.end())
    return bytes(buffer), markers, pure_markers


def walk(node):
    stack = [node]
    while stack:
        current = stack.pop()
        yield current
        stack.extend(reversed(current.named_children))


def declarator_parts(node):
    kinds = []
    while node is not None:
        kind = node.type
        if kind in ("pointer_declarator", "abstract_pointer_declarator"):
            kinds.append("pointer")
        elif kind in ("reference_declarator", "abstract_reference_declarator"):
            kinds.append("reference")
        elif kind in ("array_declarator", "abstract_array_declarator"):
            kinds.append("array")
        elif kind in ("function_declarator", "abstract_function_declarator"):
            kinds.append("function")
        elif kind not in ("init_declarator", "parenthesized_declarator", "attributed_declarator", "abstract_parenthesized_declarator"):
            return node, kinds
        inner = node.child_by_field_name("declarator")
        if inner is None:
            named = [child for child in node.named_children if child.type not in ("type_qualifier", "parameter_list", "attribute_declaration", "argument_list", "initializer_list")]
            inner = named[0] if named and kind in ("reference_declarator", "abstract_reference_declarator", "parenthesized_declarator", "attributed_declarator", "abstract_parenthesized_declarator") else None
        node = inner
    return None, kinds


def function_declarator(node):
    current = node.child_by_field_name("declarator")
    while current is not None and current.type != "function_declarator":
        inner = current.child_by_field_name("declarator")
        if inner is None:
            named = [child for child in current.named_children if child.type not in ("type_qualifier",)]
            inner = named[-1] if named else None
        current = inner
    return current


def has_word(node, kind, word):
    return any(child.type == kind and text(child) == word for child in node.children)


def type_arguments(node):
    if node.type == "qualified_identifier":
        name = node.child_by_field_name("name")
        return type_arguments(name) if name is not None else []
    if node.type == "template_type":
        arguments = node.child_by_field_name("arguments")
        return [child for child in arguments.named_children] if arguments is not None else []
    return []


@dataclass
class Violation:
    law: str
    message: str
    file: str
    line: int
    via: list = field(default_factory=list)
    fix: str = ""

    def __str__(self):
        path = f" (via {' -> '.join(self.via)})" if self.via else ""
        return f"{self.file}:{self.line}: {self.law}: {self.message}{path}. Fix: {self.fix}"


@dataclass
class Unit:
    name: str
    root: object
    markers: list
    pure_markers: list
    source: bytes = b""


@dataclass
class Member:
    owner: str
    name: str
    type: object
    kinds: list
    mutable: bool
    static: bool
    node: object
    unit: Unit


@dataclass
class Klass:
    name: str
    node: object
    unit: Unit
    bases: list
    fields: list = field(default_factory=list)
    declared: dict = field(default_factory=dict)
    shell: bool = False


@dataclass
class Function:
    name: str
    qualname: str
    owner: str
    node: object
    declarator: object
    unit: Unit
    static: bool
    const: bool
    pure: bool = False


class Checker:
    def __init__(self, sources, profile):
        self.profile = profile
        self.parser = Parser(CPP)
        self.units = []
        self.classes = {}
        self.enums = set()
        self.aliases = {}
        self.globals = {}
        self.global_decls = {}
        self.functions = []
        self.by_name = {}
        self.violations = {}
        for name, source in sources:
            prepared, markers, pure_markers = prepare(source, profile)
            unit = Unit(name, self.parser.parse(prepared).root_node, markers, pure_markers, prepared)
            self.units.append(unit)
            self.collect(unit)
        for function in self.functions:
            self.by_name.setdefault(function.name, []).append(function)
            klass = self.klass(function.owner)
            if klass is not None:
                for static, const in klass.declared.get(function.name, []):
                    function.static = function.static or static
                    function.const = function.const or const

    def klass(self, name):
        found = self.classes.get(short(name)) if name else None
        return found[0] if found else None

    def report(self, law, message, node, unit, via=()):
        key = (law, unit.name, node.start_point[0], message)
        if key not in self.violations:
            self.violations[key] = Violation(law, message, unit.name, node.start_point[0] + 1, list(via), LAWS[law])

    def collect(self, unit):
        stack = [(unit.root, None)]
        while stack:
            node, owner = stack.pop()
            kind = node.type
            if kind in ("struct_specifier", "class_specifier", "union_specifier") and node.child_by_field_name("body") is not None:
                klass = self.add_class(node, unit)
                for child in reversed(node.child_by_field_name("body").named_children):
                    stack.append((child, klass))
                continue
            if kind == "enum_specifier":
                name = node.child_by_field_name("name")
                if name is not None:
                    self.enums.add(short(text(name)))
                continue
            if kind == "function_definition":
                self.add_function(node, unit, owner)
                continue
            if kind == "field_declaration" and owner is not None:
                self.add_member(node, unit, owner)
            elif kind == "alias_declaration":
                name = node.child_by_field_name("name")
                target = node.child_by_field_name("type")
                if name is not None and target is not None:
                    self.aliases.setdefault(short(text(name)), (target.child_by_field_name("type"), declarator_parts(target.child_by_field_name("declarator"))[1]))
            elif kind == "type_definition":
                target = node.child_by_field_name("type")
                for declarator in node.children_by_field_name("declarator"):
                    name, kinds = declarator_parts(declarator)
                    if name is not None and target is not None:
                        self.aliases.setdefault(short(text(name)), (target, kinds))
            elif kind == "declaration" and owner is None and node.parent is not None and node.parent.type in ("translation_unit", "declaration_list"):
                target = node.child_by_field_name("type")
                for declarator in node.children_by_field_name("declarator"):
                    name, kinds = declarator_parts(declarator)
                    if name is not None and "function" not in kinds:
                        self.globals.setdefault(text(name), target)
                        self.global_decls.setdefault(text(name), node)
            if kind in ("compound_statement", "expression_statement", "return_statement"):
                continue
            for child in reversed(node.named_children):
                stack.append((child, owner))

    def add_class(self, node, unit):
        name_node = node.child_by_field_name("name")
        if name_node is not None and name_node.type == "template_type":
            name_node = name_node.child_by_field_name("name")
        name = short(text(name_node)) if name_node is not None else ""
        bases = []
        for child in node.named_children:
            if child.type == "base_class_clause":
                bases.extend(base for base in child.named_children if base.type in ("type_identifier", "template_type", "qualified_identifier"))
        body = node.child_by_field_name("body")
        klass = Klass(name, node, unit, bases)
        inner = [other for other in walk(body) if other is not body and other.type in ("struct_specifier", "class_specifier") and other.child_by_field_name("body") is not None]
        klass.shell = any(body.start_byte <= marker < body.end_byte and not any(other.start_byte <= marker < other.end_byte for other in inner) for marker in unit.markers)
        if name:
            self.classes.setdefault(name, []).append(klass)
        return klass

    def add_member(self, node, unit, klass):
        target = node.child_by_field_name("type")
        static = has_word(node, "storage_class_specifier", "static")
        mutable = any(text(child) == "mutable" for child in node.children if child.type in ("type_qualifier", "storage_class_specifier"))
        for declarator in node.children_by_field_name("declarator"):
            if declarator.type == "function_declarator":
                name = declarator.child_by_field_name("declarator")
                const = has_word(declarator, "type_qualifier", "const")
                klass.declared.setdefault(short(text(name)), []).append((static, const))
                continue
            name, kinds = declarator_parts(declarator)
            if name is None:
                continue
            if "function" in kinds and "pointer" not in kinds:
                continue
            klass.fields.append(Member(klass.name, text(name), target, kinds, mutable, static, node, unit))

    def add_function(self, node, unit, owner):
        declarator = function_declarator(node)
        if declarator is None:
            return
        name_node = declarator.child_by_field_name("declarator")
        if name_node is None:
            return
        qualified = bare(text(name_node))
        parts = qualified.split("::")
        name = parts[-1]
        owner_name = owner.name if owner is not None else (parts[-2] if len(parts) > 1 else None)
        qualname = f"{owner_name}::{name}" if owner_name else name
        static = has_word(node, "storage_class_specifier", "static")
        const = has_word(declarator, "type_qualifier", "const")
        pure = self.marked(unit, node)
        self.functions.append(Function(name, qualname, owner_name, node, declarator, unit, static, const, pure))

    def marked(self, unit, node):
        for marker in unit.pure_markers:
            if node.start_byte <= marker < node.end_byte:
                return True
            if marker < node.start_byte:
                between = unit.source[marker:node.start_byte]
                if b"\n" in between.strip(b" \t\r\n") or b"{" in between or b";" in between:
                    continue
                return True
        return False

    def run(self):
        p = self.profile
        sims = []
        interface_names = {entry["type"] for entry in p.interfaces}
        for name, klasses in self.classes.items():
            for klass in klasses:
                for base in klass.bases:
                    kind = short(text(base))
                    if kind in interface_names and base.type in ("template_type", "qualified_identifier"):
                        entry = next(e for e in p.interfaces if e["type"] == kind)
                        sims.append((klass, entry, type_arguments(base)))
        self.state_types = set()
        self.command_types = set()
        for klass, entry, arguments in sims:
            state_arg = entry.get("stateArgument", 0)
            command_arg = entry.get("commandArgument", 1)
            if len(arguments) > state_arg:
                self.check_root(arguments[state_arg], "state-is-data", klass)
                self.state_types.add(short(text(arguments[state_arg])))
            if entry.get("kind") == "sim" and len(arguments) > command_arg:
                self.check_root(arguments[command_arg], "commands-are-data", klass)
                self.command_types.add(short(text(arguments[command_arg])))
            elif entry.get("kind") == "layer" and len(arguments) > command_arg:
                self.check_root(arguments[command_arg], "state-is-data", klass)
                self.state_types.add(short(text(arguments[command_arg])))
        self.reached = set()
        for klass, entry, arguments in sims:
            self.check_sim(klass, tuple(entry["methods"]))
        if sims:
            self.check_logs()
            self.check_writeback({klass.name for klass, _, _ in sims})
        self.check_projects()
        for function in self.functions:
            if function.pure:
                label = function.qualname
                self.check_pure_parameters(function, label)
                self.visit(function, [label], frozenset(), "step-is-pure")
        return sorted(self.violations.values(), key=lambda violation: (violation.file, violation.line, violation.law, violation.message))

    def check_pure_parameters(self, function, label):
        parameters = function.declarator.child_by_field_name("parameters")
        for parameter in parameters.named_children if parameters is not None else []:
            name, kinds = declarator_parts(parameter.child_by_field_name("declarator"))
            if ("reference" in kinds or "pointer" in kinds) and not has_word(parameter, "type_qualifier", "const"):
                mark = "*" if "pointer" in kinds else ("&&" if b"&&" in parameter.text else "&")
                self.report("step-is-pure", f"{label} takes {squash(text(parameter.child_by_field_name('type')))}{mark} {text(name)}, which it could write into", parameter, function.unit, [label])

    def check_root(self, argument, law, klass):
        target = argument.child_by_field_name("type") if argument.type == "type_descriptor" else argument
        if target is None:
            return
        kinds = declarator_parts(argument.child_by_field_name("declarator"))[1] if argument.type == "type_descriptor" else []
        self.check_type(target, kinds, short(text(target)) or squash(text(target)), law, argument, klass.unit, set())

    def check_type(self, target, kinds, path, law, node, unit, seen):
        p = self.profile
        shown = squash(text(target))
        if "pointer" in kinds:
            self.report(law, f"{path} is a pointer ({shown}*), which reaches outside the data", node, unit)
            return
        if "reference" in kinds:
            self.report(law, f"{path} is a reference ({shown}&), which reaches outside the data", node, unit)
            return
        if target.type in ("primitive_type", "sized_type_specifier", "enum_specifier", "auto"):
            return
        if target.type in ("struct_specifier", "class_specifier", "union_specifier"):
            body = target.child_by_field_name("body")
            if body is not None:
                anonymous = Klass(path, target, unit, [])
                for child in body.named_children:
                    if child.type == "field_declaration":
                        self.add_member(child, unit, anonymous)
                self.check_struct(anonymous, path, law, seen)
                return
        name = bare(text(target))
        last = name.split("::")[-1]
        if name in p.functions or last in p.functions:
            self.report(law, f"{path} is a function ({shown}), which is code, not data", node, unit)
        elif name in p.handles or last in p.handles:
            self.report(law, f"{path} is the handle {last}, which points at something outside the data", node, unit)
        elif name in p.unordered or last in p.unordered:
            self.report(law, f"{path} is {last}, whose iteration order is not part of the data; use a sorted TArray of pairs", node, unit)
        elif name in p.containers or last in p.containers:
            for argument in type_arguments(target):
                if argument.type == "type_descriptor":
                    inner = argument.child_by_field_name("type")
                    if inner is not None and not short(text(inner)).endswith("Allocator"):
                        self.check_type(inner, declarator_parts(argument.child_by_field_name("declarator"))[1], path, law, node, unit, seen)
                elif argument.type in ("identifier", "type_identifier", "qualified_identifier"):
                    self.check_type(argument, [], path, law, node, unit, seen)
        elif name in p.values or last in p.values or last in self.enums:
            return
        elif last in self.aliases and last not in seen:
            alias, alias_kinds = self.aliases[last]
            if alias is not None:
                self.check_type(alias, alias_kinds + kinds, path, law, node, unit, seen | {last})
        elif p.engine_object.match(last):
            self.report(law, f"{path} holds the engine object {last} by value, which lives in the engine, not in the data", node, unit)
        elif self.klass(last) is not None:
            self.check_struct(self.klass(last), path, law, seen)
        else:
            self.report(law, f"{path} is {last}, which the checker cannot see; build it in the project from plain values", node, unit)

    def check_struct(self, klass, path, law, seen):
        key = id(klass.node)
        if key in seen:
            return
        seen = seen | {key}
        for base in klass.bases:
            self.check_type(base, [], path, law, base, klass.unit, seen)
        for member in klass.fields:
            if member.static:
                continue
            if member.type is None:
                continue
            self.check_type(member.type, member.kinds, f"{path}.{member.name}", law, member.node, member.unit, seen)

    def methods(self, owner, name, seen=None):
        seen = seen or set()
        if not owner or owner in seen:
            return []
        seen.add(owner)
        found = [function for function in self.by_name.get(name, []) if function.owner == owner]
        if found:
            return found
        klass = self.klass(owner)
        for base in klass.bases if klass is not None else []:
            found = self.methods(short(text(base)), name, seen)
            if found:
                return found
        return []

    def check_sim(self, klass, entries):
        for member in klass.fields:
            if member.mutable:
                self.report("step-is-pure", f"{klass.name}.{member.name} is a mutable member, which even a const Step can write", member.node, member.unit)
        for entry in entries:
            for function in self.methods(klass.name, entry):
                if function.owner != klass.name:
                    continue
                label = f"{klass.name}::{entry}"
                if entry != "Init" and not function.static and not function.const:
                    self.report("step-is-pure", f"{label} is neither static nor const, so it can change the sim between steps", function.node, function.unit, [label])
                parameters = function.declarator.child_by_field_name("parameters")
                for parameter in parameters.named_children if parameters is not None else []:
                    name, kinds = declarator_parts(parameter.child_by_field_name("declarator"))
                    if ("reference" in kinds or "pointer" in kinds) and not has_word(parameter, "type_qualifier", "const"):
                        mark = "*" if "pointer" in kinds else ("&&" if b"&&" in parameter.text else "&")
                        self.report("step-is-pure", f"{label} takes {squash(text(parameter.child_by_field_name('type')))}{mark} {text(name)}, which it could write into", parameter, function.unit, [label])
                self.visit(function, [label], frozenset(), "step-is-pure")

    def scope(self, function):
        names = {}
        for node in walk(function.node):
            if node.type in ("declaration", "parameter_declaration", "optional_parameter_declaration", "for_range_loop", "field_declaration"):
                target = node.child_by_field_name("type")
                for declarator in node.children_by_field_name("declarator"):
                    name, _ = declarator_parts(declarator)
                    if name is not None and name.type in ("identifier", "field_identifier"):
                        names[text(name)] = short(text(target)) if target is not None else ""
            elif node.type == "structured_binding_declarator":
                for child in node.named_children:
                    if child.type == "identifier":
                        names[text(child)] = ""
            elif node.type == "lambda_capture_specifier":
                for child in node.named_children:
                    if child.type == "identifier":
                        names.setdefault(text(child), "")
        return names

    def member_type(self, owner, name):
        klass = self.klass(owner)
        while klass is not None:
            for member in klass.fields:
                if member.name == name and member.type is not None:
                    return short(text(member.type))
            klass = next((self.klass(short(text(base))) for base in klass.bases if self.klass(short(text(base))) is not None), None)
        return None

    def receiver(self, node, function, names):
        root, _ = self.root(node)
        if root is None:
            return None
        if root.type == "this":
            if node.type == "this":
                return function.owner
            if node.type == "field_expression" and node.child_by_field_name("argument").type == "this":
                return self.member_type(function.owner, text(node.child_by_field_name("field")))
            return None
        if root is not node or root.type != "identifier":
            return None
        name = text(root)
        if name in names:
            return names[name]
        found = self.member_type(function.owner, name)
        if found:
            return found
        target = self.globals.get(name)
        return short(text(target)) if target is not None else None

    def root(self, node):
        through = False
        while node is not None:
            kind = node.type
            if kind == "field_expression":
                argument = node.child_by_field_name("argument")
                if text(node.child_by_field_name("operator")) == "->" and argument is not None and argument.type != "this":
                    through = True
                node = argument
            elif kind == "subscript_expression":
                node = node.child_by_field_name("argument")
            elif kind == "parenthesized_expression":
                node = node.named_children[0] if node.named_children else None
            elif kind == "pointer_expression":
                through = through or text(node.child_by_field_name("operator")) == "*"
                node = node.child_by_field_name("argument")
            else:
                return node, through
        return None, through

    def targets(self, call, function, names):
        callee = call.child_by_field_name("function")
        if callee is None:
            return []
        if callee.type == "template_function":
            callee = callee.child_by_field_name("name")
        if callee is None:
            return []
        if callee.type == "identifier":
            name = text(callee)
            if name in names:
                return []
            return self.methods(function.owner, name) or [candidate for candidate in self.by_name.get(name, []) if candidate.owner is None]
        if callee.type == "qualified_identifier":
            parts = bare(text(callee)).split("::")
            if len(parts) > 1 and self.klass(parts[-2]) is not None:
                return self.methods(parts[-2], parts[-1])
            return [candidate for candidate in self.by_name.get(parts[-1], []) if candidate.owner is None or candidate.qualname.endswith("::".join(parts))]
        if callee.type == "field_expression":
            argument = callee.child_by_field_name("argument")
            owner = self.receiver(argument, function, names) if argument is not None else None
            return self.methods(owner, text(callee.child_by_field_name("field"))) if owner else []
        return []

    def visit(self, function, via, stack, law):
        p = self.profile
        key = (function.unit.name, function.node.start_byte)
        if key in stack:
            return
        stack = stack | {key}
        self.reached.add(key)
        body = function.node.child_by_field_name("body")
        if body is None:
            return
        names = self.scope(function)
        who = via[-1]
        unit = function.unit

        def pure(message, node):
            self.report(law, f"{who} {message}", node, unit, via)

        for node in walk(body):
            kind = node.type
            if kind == "qualified_identifier" and node.parent is not None and node.parent.type != "qualified_identifier":
                name = bare(text(node))
                parts = name.split("::")
                if name.startswith(p.clocks):
                    pure(f"reads the clock through {name}", node)
                elif parts[0] in p.random_owners and parts[-1] in p.random_names:
                    pure(f"draws {parts[0]} random through {name}", node)
                elif parts[0] in p.world_owners:
                    pure(f"reaches the world through {name}", node)
                elif name in p.io_names:
                    pure(f"draws random through {name}", node)
                elif parts[-1] in p.heap_calls and parts[0] == "FMemory":
                    pure(f"allocates on the heap through {name}", node)
            elif kind == "call_expression":
                call_name = None
                callee = node.child_by_field_name("function")
                if callee is not None and callee.type == "template_function":
                    callee = callee.child_by_field_name("name")
                if callee is not None and callee.type == "identifier":
                    call_name = text(callee)
                elif callee is not None and callee.type == "field_expression":
                    call_name = text(callee.child_by_field_name("field"))
                if call_name in p.world_calls:
                    pure(f"reaches the world through {call_name}()", node)
                elif call_name in ("rand", "srand"):
                    pure(f"draws random through {call_name}()", node)
                elif call_name in ("time", "clock") and callee.type == "identifier":
                    pure(f"reads the clock through {call_name}()", node)
                elif call_name in p.heap_calls and callee.type == "identifier":
                    pure(f"allocates on the heap through {call_name}", node)
                elif call_name == "FRandomStream" and callee.type == "identifier":
                    pure("makes FRandomStream; carry a seed in the state and derive values from it", node)
                if callee is not None and callee.type == "field_expression" and call_name in p.mutators:
                    self.check_write(callee.child_by_field_name("argument"), names, pure, node, f" through {call_name}")
                for target in self.targets(node, function, names):
                    self.visit(target, via + [target.qualname], stack, law)
            elif kind == "compound_literal_expression" and short(text(node.child_by_field_name("type"))) == "FRandomStream":
                pure("makes FRandomStream; carry a seed in the state and derive values from it", node)
            elif kind == "new_expression":
                pure("allocates on the heap with new", node)
            elif kind == "delete_expression":
                pure("frees memory with delete", node)
            elif kind == "field_expression" and text(node.child_by_field_name("operator")) == "->":
                argument = node.child_by_field_name("argument")
                if argument is not None and argument.type != "this":
                    pure(f"follows a pointer with -> in {squash(text(node))[:60]}", node)
            elif kind == "identifier" and p.engine_global.match(text(node)) and text(node) not in names and text(node) not in self.by_name and self.klass(text(node)) is None:
                pure(f"reads the engine global {text(node)}", node)
            elif kind == "declaration":
                target = node.child_by_field_name("type")
                declared = [text(declarator_parts(declarator)[0]) for declarator in node.children_by_field_name("declarator")]
                if any(child.type == "storage_class_specifier" and text(child) in ("static", "thread_local") for child in node.children):
                    pure(f"keeps the static local {', '.join(declared)}, which outlives the step", node)
                if target is not None and short(text(target)) == "FRandomStream":
                    pure(f"makes FRandomStream {', '.join(declared)}; carry a seed in the state and derive values from it", node)
            elif kind == "assignment_expression":
                self.check_write(node.child_by_field_name("left"), names, pure, node, "")
            elif kind == "update_expression":
                self.check_write(node.child_by_field_name("argument"), names, pure, node, "")

    def check_write(self, target, names, pure, node, how):
        if target is None:
            return
        root, through = self.root(target)
        if root is None:
            return
        if root.type == "identifier" and text(root) in names:
            if through:
                pure(f"writes through a pointer into {squash(text(target))}{how}", node)
            return
        if root.type == "call_expression":
            return
        subject = text(root) if root.type in ("identifier", "qualified_identifier") else squash(text(target))
        pure(f"writes into {subject}{how}, which it did not create", node)

    def check_logs(self):
        p = self.profile
        for unit in self.units:
            for node in walk(unit.root):
                if node.type != "template_type" or short(text(node)) not in p.mutable_sequences:
                    continue
                arguments = type_arguments(node)
                inner = arguments[0].child_by_field_name("type") if arguments and arguments[0].type == "type_descriptor" else None
                if inner is None or inner.type != "template_type" or short(text(inner)) not in p.mutable_sequences:
                    continue
                element = type_arguments(inner)
                element = element[0].child_by_field_name("type") if element and element[0].type == "type_descriptor" else None
                if element is None or short(text(element)) not in self.command_types:
                    continue
                holder = node.parent
                while holder is not None and holder.type not in ("field_declaration", "declaration", "parameter_declaration"):
                    holder = holder.parent
                name = ""
                if holder is not None:
                    declarator = holder.child_by_field_name("declarator")
                    found = declarator_parts(declarator)[0] if declarator is not None else None
                    name = text(found) if found is not None else ""
                self.report("log-is-append-only", f"{name or 'a log'} keeps commands as {squash(text(node))}, which can be rewritten in place", node, unit)

    def check_writeback(self, sims):
        shell_fields = set()
        for klasses in self.classes.values():
            for klass in klasses:
                if klass.shell:
                    shell_fields.update(member.name for member in klass.fields if member.type is not None and (short(text(member.type)) in self.state_types or short(text(member.type)) == self.profile.append_only))
        for function in self.functions:
            klass = self.klass(function.owner)
            if function.owner in sims or (klass is not None and klass.shell):
                continue
            if (function.unit.name, function.node.start_byte) in self.reached:
                continue
            body = function.node.child_by_field_name("body")
            if body is None:
                continue
            names = self.scope(function)
            for node in walk(body):
                if node.type == "call_expression":
                    callee = node.child_by_field_name("function")
                    if callee is None:
                        continue
                    stepped = None
                    if callee.type == "field_expression" and text(callee.child_by_field_name("field")) == "Step":
                        stepped = self.receiver(callee.child_by_field_name("argument"), function, names)
                    elif callee.type == "qualified_identifier":
                        parts = bare(text(callee)).split("::")
                        stepped = parts[-2] if len(parts) > 1 and parts[-1] == "Step" else None
                    if stepped in sims:
                        self.report("project-never-writes-back", f"{function.qualname} steps the sim {stepped} outside a {self.profile.shell_marker} class", node, function.unit)
                elif node.type in ("assignment_expression", "update_expression"):
                    target = node.child_by_field_name("left" if node.type == "assignment_expression" else "argument")
                    chain = []
                    current = target
                    while current is not None and current.type in ("field_expression", "subscript_expression", "parenthesized_expression"):
                        if current.type == "field_expression":
                            chain.append(text(current.child_by_field_name("field")))
                            current = current.child_by_field_name("argument")
                        else:
                            current = current.named_children[0] if current.named_children else None
                    if current is not None and current.type != "this" and shell_fields.intersection(chain):
                        self.report("project-never-writes-back", f"{function.qualname} writes {squash(text(target))}, which belongs to a sim shell", node, function.unit)

    def check_projects(self):
        for klasses in list(self.classes.values()):
            for klass in klasses:
                if not klass.shell:
                    continue
                for function in self.methods(klass.name, self.profile.project_method):
                    label = f"{function.owner}::{self.profile.project_method}"
                    parameters = function.declarator.child_by_field_name("parameters")
                    for parameter in parameters.named_children if parameters is not None else []:
                        name, kinds = declarator_parts(parameter.child_by_field_name("declarator"))
                        if ("reference" in kinds or "pointer" in kinds) and not has_word(parameter, "type_qualifier", "const"):
                            mark = "*" if "pointer" in kinds else "&"
                            self.report("project-is-a-function-of-state", f"{label} takes {squash(text(parameter.child_by_field_name('type')))}{mark} {text(name)}, which it could write into", parameter, function.unit, [label])
                    self.visit_project(function, [label], frozenset())

    def shell_fields(self, owner):
        klass = self.klass(owner)
        fields = {}
        seen = set()
        while klass is not None and id(klass.node) not in seen:
            seen.add(id(klass.node))
            for member in klass.fields:
                fields.setdefault(member.name, member)
            klass = next((self.klass(short(text(base))) for base in klass.bases if self.klass(short(text(base))) is not None), None)
        return fields

    def constant(self, node):
        return any(child.type == "type_qualifier" and text(child) in ("const", "constexpr", "consteval", "constinit") for child in node.children)

    def target(self, target, kinds):
        p = self.profile
        if target is None:
            return False
        last = short(text(target))
        if "pointer" in kinds or "reference" in kinds:
            return bool(p.engine_object.match(last))
        if last in p.object_pointers:
            return True
        if last in p.target_containers:
            arguments = [argument for argument in type_arguments(target) if argument.type == "type_descriptor"]
            return bool(arguments) and self.target(arguments[0].child_by_field_name("type"), declarator_parts(arguments[0].child_by_field_name("declarator"))[1])
        return False

    def visit_project(self, function, via, stack):
        p = self.profile
        key = (function.unit.name, function.node.start_byte)
        if key in stack:
            return
        stack = stack | {key}
        body = function.node.child_by_field_name("body")
        if body is None:
            return
        names = self.scope(function)
        who = via[-1]
        unit = function.unit
        owner = self.klass(function.owner)
        fields = self.shell_fields(function.owner) if owner is not None and owner.shell else {}

        def bad(message, node):
            self.report("project-is-a-function-of-state", f"{who} {message}", node, unit, via)

        def member(name, node):
            found = fields.get(name)
            if found is None or self.constant(found.node) or self.target(found.type, found.kinds):
                return
            bad(f"reads the shell's mutable member {name}, which is memory outside the state", node)

        for node in walk(body):
            kind = node.type
            if kind == "qualified_identifier" and node.parent is not None and node.parent.type != "qualified_identifier":
                name = bare(text(node))
                parts = name.split("::")
                if name.startswith(p.clocks) or parts[-1] in p.time_calls:
                    bad(f"reads the clock through {name}", node)
                elif parts[0] in p.random_owners and parts[-1] in p.random_names:
                    bad(f"draws {parts[0]} random through {name}", node)
                elif parts[0] == "UKismetMathLibrary" and parts[-1].startswith("Random"):
                    bad(f"draws random through {name}", node)
                elif name in p.io_names:
                    bad(f"draws random through {name}", node)
                elif len(parts) > 1 and self.klass(parts[-2]) is not None:
                    held = next((candidate for candidate in self.klass(parts[-2]).fields if candidate.name == parts[-1]), None)
                    if held is not None and held.static and not self.constant(held.node):
                        bad(f"reads the static mutable {name}", node)
            elif kind == "call_expression":
                callee = node.child_by_field_name("function")
                if callee is not None and callee.type == "template_function":
                    callee = callee.child_by_field_name("name")
                call_name = None
                if callee is not None and callee.type == "identifier":
                    call_name = text(callee)
                elif callee is not None and callee.type == "field_expression":
                    call_name = text(callee.child_by_field_name("field"))
                if call_name in p.time_calls:
                    bad(f"reads the clock through {call_name}()", node)
                elif call_name in ("rand", "srand") and callee.type == "identifier":
                    bad(f"draws random through {call_name}()", node)
                elif call_name in ("time", "clock") and callee.type == "identifier":
                    bad(f"reads the clock through {call_name}()", node)
                elif call_name == "FRandomStream" and callee.type == "identifier":
                    bad("makes FRandomStream; carry a seed in the state and derive values from it", node)
                for found in self.targets(node, function, names):
                    self.visit_project(found, via + [found.qualname], stack)
            elif kind == "compound_literal_expression" and short(text(node.child_by_field_name("type"))) == "FRandomStream":
                bad("makes FRandomStream; carry a seed in the state and derive values from it", node)
            elif kind == "field_expression":
                field_name = text(node.child_by_field_name("field"))
                argument = node.child_by_field_name("argument")
                if field_name in p.time_fields:
                    bad(f"reads the clock through {squash(text(node))[:60]}", node)
                elif argument is not None and argument.type == "this":
                    member(field_name, node)
            elif kind == "identifier":
                name = text(node)
                if name in names:
                    continue
                if name in fields:
                    member(name, node)
                elif p.engine_global.match(name) and name not in self.by_name and self.klass(name) is None:
                    bad(f"reads the engine global {name}", node)
                elif name in self.global_decls and not self.constant(self.global_decls[name]):
                    bad(f"reads the mutable global {name}", node)
            elif kind == "declaration":
                target = node.child_by_field_name("type")
                declared = [text(declarator_parts(declarator)[0]) for declarator in node.children_by_field_name("declarator")]
                if any(child.type == "storage_class_specifier" and text(child) in ("static", "thread_local") for child in node.children) and not self.constant(node):
                    bad(f"keeps the static local {', '.join(declared)}, which carries memory from frame to frame", node)
                if target is not None and short(text(target)) == "FRandomStream":
                    bad(f"makes FRandomStream {', '.join(declared)}; carry a seed in the state and derive values from it", node)


def check_sources(sources, profile=None):
    return Checker(list(sources), profile or load_profile("ue")).run()


def gather(paths, profile, root=None):
    files = []
    for path in map(Path, paths):
        if path.is_dir():
            files.extend(sorted(candidate for candidate in path.rglob("*") if candidate.suffix.lower() in profile.suffixes and candidate.is_file()))
        elif path.is_file():
            files.append(path)
    sources = []
    for path in files:
        try:
            name = path.resolve().relative_to(Path(root).resolve()).as_posix() if root is not None else path.as_posix()
        except ValueError:
            name = path.as_posix()
        sources.append((name, path.read_bytes()))
    return sources


def check_paths(paths, root=None, profile=None):
    profile = profile or load_profile("ue")
    return check_sources(gather(paths, profile, root), profile)


def main(arguments):
    profile_name = "ue"
    rest = []
    index = 0
    while index < len(arguments):
        if arguments[index] == "--profile" and index + 1 < len(arguments):
            profile_name = arguments[index + 1]
            index += 2
        else:
            rest.append(arguments[index])
            index += 1
    if not rest:
        print("usage: python laws.py [--profile <name|path>] <dir or file>...", file=sys.stderr)
        return 2
    started = time.perf_counter()
    profile = load_profile(profile_name)
    sources = gather(rest, profile)
    violations = check_sources(sources, profile)
    for violation in violations:
        print(violation)
    print(f"{len(violations)} violation(s) in {len(sources)} file(s), {time.perf_counter() - started:.2f}s", file=sys.stderr)
    return 1 if violations else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
