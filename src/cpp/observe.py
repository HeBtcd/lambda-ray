import json
import re
import sys
from pathlib import Path

import tree_sitter_cpp
from tree_sitter import Language, Parser

CPP = Language(tree_sitter_cpp.language())

TYPE_CONTEXT_PARENTS = {
    "type_descriptor",
    "template_argument_list",
    "base_class_clause",
    "using_declaration",
    "alias_declaration",
    "sizeof_expression",
    "alignof_expression",
    "static_assert_declaration",
}

NAMED_TYPE_DECLS = {
    "namespace_definition",
    "struct_specifier",
    "class_specifier",
    "enum_specifier",
}

TYPED_FIELD_NODES = {
    "declaration",
    "field_declaration",
    "parameter_declaration",
    "optional_parameter_declaration",
    "function_definition",
    "cast_expression",
    "compound_literal_expression",
    "for_range_loop",
}


CAST_OPS = {"static_cast", "const_cast", "reinterpret_cast", "dynamic_cast"}
DECL_WRAPPERS = {
    "pointer_declarator",
    "reference_declarator",
    "array_declarator",
    "parenthesized_declarator",
    "attributed_declarator",
}


def strip_templates(value):
    while True:
        nxt = re.sub(r"<[^<>]*>", "", value)
        if nxt == value:
            return value
        value = nxt


def txt(node):
    return node.text.decode("utf-8", "replace") if node is not None else ""


def loc(node):
    return {"line": node.start_point[0] + 1, "col": node.start_point[1] + 1}


def first_id(node):
    if node is None or node.type == "parameter_list":
        return None
    if node.type in ("identifier", "field_identifier"):
        return node
    for c in node.children:
        r = first_id(c)
        if r is not None:
            return r
    return None


def find_fn_declarator(node):
    if node.type in ("function_declarator", "abstract_function_declarator"):
        return node
    d = node.child_by_field_name("declarator")
    while d is not None and d.type not in ("function_declarator", "abstract_function_declarator"):
        nxt = d.child_by_field_name("declarator") or next(
            (c for c in d.children if c.type.endswith("declarator")),
            None,
        )
        if nxt is None:
            return d
        d = nxt
    return d


def fn_name_parts(node, ns_prefix, class_prefix):
    d = find_fn_declarator(node)
    if d is None:
        return None, class_prefix
    ident = d.child_by_field_name("declarator")
    if ident is not None and ident.type == "qualified_identifier":
        raw = txt(ident)
        parts = raw.split("::")
        owner = "::".join([*ns_prefix, *(strip_templates(p) for p in parts[:-1])]) if len(parts) > 1 else class_prefix
        full = "::".join([*ns_prefix, raw]) if ns_prefix else raw
        return full, owner
    if ident is not None and ident.type in ("operator_name", "destructor_name"):
        prefix = class_prefix or "::".join(ns_prefix)
        full = f"{prefix}::{txt(ident)}" if prefix else txt(ident)
        return full, class_prefix
    n = first_id(d)
    if n is None:
        return None, class_prefix
    prefix = class_prefix or "::".join(ns_prefix)
    full = f"{prefix}::{txt(n)}" if prefix else txt(n)
    return full, class_prefix


def fn_params(node):
    d = node.child_by_field_name("declarator")
    while d is not None and d.type not in ("function_declarator", "abstract_function_declarator"):
        d = d.child_by_field_name("declarator") or next(
            (c for c in d.children if c.type.endswith("declarator")),
            None,
        )
    plist = d.child_by_field_name("parameters") if d is not None else None
    if plist is None:
        plist = next((c for c in (d.children if d else []) if c.type == "parameter_list"), None)
    params = []
    if plist is None:
        return params
    for p in plist.children:
        if p.type in ("parameter_declaration", "optional_parameter_declaration"):
            decl = p.child_by_field_name("declarator")
            n = first_id(decl if decl is not None else p)
            if n is not None:
                params.append(txt(n))
    return params


def decl_qualifiers(node):
    quals = {
        txt(c)
        for c in node.children
        if c.type in ("type_qualifier", "storage_class_specifier")
    }
    if "const" in quals or "constexpr" in quals or "constinit" in quals:
        return "const", quals
    return "mutable", quals


def unwrap_chain(node):
    path = []
    n = node
    while n is not None:
        if n.type == "parenthesized_expression":
            n = next((c for c in n.named_children), None)
            continue
        if n.type == "subscript_expression":
            path.insert(0, "(index)")
            n = n.child_by_field_name("argument") or n.child_by_field_name("value")
            continue
        if n.type == "field_expression":
            f = n.child_by_field_name("field")
            path.insert(0, txt(f) if f is not None else "?")
            n = n.child_by_field_name("argument")
            continue
        if n.type == "pointer_expression" and txt(n.child_by_field_name("operator")) == "*":
            path.insert(0, "*")
            n = n.child_by_field_name("argument")
            continue
        break
    return n, path


def is_type_node(node):
    cur = node
    p = node.parent
    while p is not None:
        if p.type in TYPE_CONTEXT_PARENTS:
            return True
        if p.type in NAMED_TYPE_DECLS and p.child_by_field_name("name") == cur:
            return True
        if p.type in TYPED_FIELD_NODES and p.child_by_field_name("type") == cur:
            return True
        if p.type not in ("qualified_identifier", "template_type", "sized_type_specifier", "type_qualifier"):
            return False
        cur = p
        p = p.parent
    return False


def is_value_read(node):
    if is_type_node(node):
        return False
    par = node.parent
    if par is None:
        return False
    if par.type == "field_expression" and par.child_by_field_name("field") == node:
        return False
    if par.type == "call_expression" and par.child_by_field_name("function") == node:
        return False
    if par.type == "assignment_expression" and par.child_by_field_name("left") == node:
        return False
    if par.type == "qualified_identifier":
        return False
    cur = node
    par = node.parent
    while par is not None and par.type in DECL_WRAPPERS:
        cur = par
        par = par.parent
    if par is None:
        return False
    if par.type in ("init_declarator", "for_range_loop", "parameter_declaration", "optional_parameter_declaration"):
        return par.child_by_field_name("declarator") != cur
    if par.type in (
        "function_declarator",
        "field_declaration",
        "declaration",
        "labeled_statement",
        "goto_statement",
        "break_statement",
        "continue_statement",
    ):
        return False
    return True


def observe(path):
    p = Path(path).resolve()
    tree = Parser(CPP).parse(p.read_bytes())
    file_str = p.as_posix()

    module_vars = {}
    class_fields = {}
    fn_defs = []
    fn_by_name = {}
    declarations = []
    comment_spans = []
    imports = []
    hazards = []
    syntax_kinds = []

    BLACKBOARD_NAMES = {
        "Blackboard", "GameplayTag", "GameplayTagContainer",
        "FGameplayTag", "FGameplayTagContainer", "UAbilitySystemComponent", "UAttributeSet",
    }

    def scan_syntax_extras(node):
        t = node.type
        if t == "comment":
            text = txt(node)
            comment_spans.append({
                "kind": "block" if text.startswith("/*") else "line",
                "line": node.start_point[0] + 1,
                "endLine": node.end_point[0] + 1,
                "col": node.start_point[1] + 1,
            })
            return
        if t in ("storage_class_specifier", "type_qualifier", "virtual_specifier"):
            syntax_kinds.append({"kind": f"{t}:{txt(node).strip()}", **loc(node)})
        elif t == "virtual":
            syntax_kinds.append({"kind": "virtual", **loc(node)})
        elif t == "template_function" and txt(node.child_by_field_name("name")) in CAST_OPS:
            syntax_kinds.append({"kind": f"cast:{txt(node.child_by_field_name('name'))}", **loc(node)})
        elif node.is_named:
            syntax_kinds.append({"kind": t, **loc(node)})
        if t == "preproc_include":
            path_node = node.child_by_field_name("path") or next(
                (c for c in node.children if c.type in ("system_lib_string", "string_literal")),
                None,
            )
            if path_node is not None:
                raw = txt(path_node)
                src = raw.strip('"') if path_node.type == "string_literal" else raw
                imports.append({"source": src, "kind": "include", **loc(node)})
            return
        if t == "goto_statement":
            hazards.append({"kind": "unsafe", "detail": "goto", **loc(node)})
        elif t == "template_function":
            fname = txt(node.child_by_field_name("name"))
            if fname in ("reinterpret_cast", "const_cast"):
                hazards.append({"kind": "unsafe", "detail": fname, **loc(node)})
            elif fname in ("dynamic_cast", "std::any_cast", "any_cast"):
                hazards.append({"kind": "reflection", "detail": fname, **loc(node)})
        elif t == "call_expression":
            fn_node = node.child_by_field_name("function")
            if fn_node is not None and txt(fn_node) == "typeid":
                hazards.append({"kind": "reflection", "detail": "typeid", **loc(node)})
        elif t in ("typeid_expression",):
            hazards.append({"kind": "reflection", "detail": "typeid", **loc(node)})
        elif t == "template_type":
            raw_t = txt(node)
            tname = txt(node.child_by_field_name("name"))
            if ("unordered_map" in tname or tname.endswith("map")) and "std::any" in raw_t:
                hazards.append({"kind": "blackboard", "detail": raw_t, **loc(node)})
            elif tname == "TMap" and ("FName" in raw_t or "GameplayTag" in raw_t):
                hazards.append({"kind": "blackboard", "detail": raw_t, **loc(node)})
        elif t in ("type_identifier", "qualified_identifier"):
            q = txt(node)
            base_q = q.split("::")[-1]
            if q == "std::any":
                hazards.append({"kind": "reflection", "detail": "std::any", **loc(node)})
            elif base_q in BLACKBOARD_NAMES and node.parent is not None and node.parent.type not in ("base_class_clause",):
                hazards.append({"kind": "blackboard", "detail": q, **loc(node)})
        for c in node.children:
            scan_syntax_extras(c)

    scan_syntax_extras(tree.root_node)

    def extract_bases(type_node):
        bases = []
        bc = next((c for c in type_node.children if c.type == "base_class_clause"), None)
        if bc is None:
            return bases
        for c in bc.children:
            if c.type in ("type_identifier", "qualified_identifier", "template_type"):
                bases.append(txt(c))
        return bases

    def fn_poly_modifiers(node):
        mods = []
        has_eq_zero = False
        saw_eq = False
        for c in node.children:
            if c.type == "virtual":
                mods.append("virtual")
            elif c.type == "virtual_specifier":
                vtxt = txt(c).strip()
                if vtxt in ("override", "final") and vtxt not in mods:
                    mods.append(vtxt)
            elif txt(c) == "=":
                saw_eq = True
            elif saw_eq and c.type == "number_literal" and txt(c) == "0":
                has_eq_zero = True
        if has_eq_zero:
            mods.append("abstract")
        return mods

    def collect_top(node, ns_prefix, class_prefix):
        t = node.type
        if t == "namespace_definition":
            ns_name = node.child_by_field_name("name")
            next_ns = [*ns_prefix, txt(ns_name)] if ns_name is not None else ns_prefix
            body = node.child_by_field_name("body")
            if body is not None:
                for c in body.children:
                    collect_top(c, next_ns, class_prefix)
            return
        if t in ("class_specifier", "struct_specifier"):
            cname = node.child_by_field_name("name")
            body = node.child_by_field_name("body")
            bases = extract_bases(node)
            if cname is not None and (body is not None or bases):
                cqual = f"{class_prefix}::{txt(cname)}" if class_prefix else ("::".join([*ns_prefix, txt(cname)]) if ns_prefix else txt(cname))
                kind = "class" if t == "class_specifier" else "struct"
                mods = [txt(c).strip() for c in node.children if c.type == "virtual_specifier"]
                declarations.append({
                    "kind": kind,
                    "name": cqual,
                    "bases": bases,
                    "modifiers": mods,
                    **loc(node),
                })
                class_fields.setdefault(cqual, {})
                if body is not None:
                    for c in body.children:
                        collect_top(c, ns_prefix, cqual)
                return
        if t == "enum_specifier":
            ename = node.child_by_field_name("name")
            body = node.child_by_field_name("body")
            if ename is not None and body is not None:
                equal = f"{class_prefix}::{txt(ename)}" if class_prefix else ("::".join([*ns_prefix, txt(ename)]) if ns_prefix else txt(ename))
                is_scoped = any(c.type in ("class", "struct") for c in node.children)
                declarations.append({
                    "kind": "enum",
                    "name": equal,
                    "bases": [],
                    "modifiers": ["class"] if is_scoped else [],
                    **loc(node),
                })
            return
        if t == "template_declaration":
            for c in node.children:
                if c.is_named and c.type != "template_parameter_list":
                    collect_top(c, ns_prefix, class_prefix)
            return
        if t == "field_declaration" and class_prefix:
            nested_handled = False
            for c in node.children:
                if c.type in ("class_specifier", "struct_specifier", "enum_specifier"):
                    collect_top(c, ns_prefix, class_prefix)
                    nested_handled = True
            if nested_handled:
                return
            decl_kind, quals = decl_qualifiers(node)
            scope = "module" if "static" in quals else "member"
            poly_mods = fn_poly_modifiers(node)
            for d in node.children_by_field_name("declarator"):
                fn_d = find_fn_declarator(d)
                if d.type == "function_declarator" or (fn_d is not None and fn_d.type == "function_declarator"):
                    if poly_mods:
                        fid = first_id(fn_d or d)
                        mname = f"{class_prefix}::{txt(fid)}" if fid is not None else class_prefix
                        declarations.append({
                            "kind": "method",
                            "name": mname,
                            "bases": [],
                            "modifiers": poly_mods,
                            **loc(node),
                        })
                    continue
                fid = first_id(d)
                if fid is not None:
                    fname = txt(fid)
                    class_fields[class_prefix][fname] = (scope, decl_kind)
                    if "static" in quals:
                        declarations.append({
                            "kind": "field",
                            "name": f"{class_prefix}::{fname}",
                            "bases": [],
                            "modifiers": ["static", decl_kind],
                            **loc(node),
                        })
            return
        if t == "declaration" and not class_prefix:
            decl_kind, _ = decl_qualifiers(node)
            for d in node.children_by_field_name("declarator"):
                fn_d = find_fn_declarator(d)
                if d.type == "function_declarator" or (fn_d is not None and fn_d.type == "function_declarator"):
                    continue
                fid = first_id(d)
                if fid is not None:
                    name = txt(fid)
                    qual = "::".join([*ns_prefix, name]) if ns_prefix else name
                    module_vars[name] = decl_kind
                    module_vars[qual] = decl_kind
                    declarations.append({
                        "kind": "variable",
                        "name": qual,
                        "bases": [],
                        "modifiers": ["module", decl_kind],
                        **loc(node),
                    })
            return
        if t == "function_definition":
            qual, owner = fn_name_parts(node, ns_prefix, class_prefix)
            if qual:
                poly_mods = fn_poly_modifiers(node)
                if poly_mods:
                    declarations.append({
                        "kind": "method",
                        "name": qual,
                        "bases": [],
                        "modifiers": poly_mods,
                        **loc(node),
                    })
                fn_defs.append((qual, owner, node))
                fn_by_name[qual] = qual
                short_name = qual.split("::")[-1]
                fn_by_name.setdefault(short_name, qual)
            return
        if t in ("translation_unit", "declaration_list", "field_declaration_list"):
            for c in node.children:
                collect_top(c, ns_prefix, class_prefix)
            return

    collect_top(tree.root_node, [], None)

    def compute_metrics(fn_node, body_node):
        lines = fn_node.end_point[0] - fn_node.start_point[0] + 1
        branches = 0
        max_nesting = 0
        NEST_TYPES = {
            "if_statement", "switch_statement", "for_statement",
            "for_range_loop", "while_statement", "do_statement", "try_statement",
        }
        BRANCH_TYPES = {
            "if_statement", "case_statement", "catch_clause", "conditional_expression",
            "for_statement", "for_range_loop", "while_statement", "do_statement",
        }

        def walk_m(n, depth):
            nonlocal branches, max_nesting
            if n is None or n.type in ("lambda_expression", "function_definition"):
                return
            next_depth = depth
            is_else_if = (
                n.type == "if_statement"
                and n.parent is not None
                and n.parent.type == "else_clause"
            )
            if n.type in NEST_TYPES and not is_else_if:
                next_depth = depth + 1
                if next_depth > max_nesting:
                    max_nesting = next_depth
            if n.type in BRANCH_TYPES:
                branches += 1
            for c in n.children:
                walk_m(c, next_depth)

        if body_node is not None:
            walk_m(body_node, 0)
        return {"lines": lines, "branches": branches, "maxNesting": max_nesting}

    def empty_bucket(name, node, params, body_node):
        return {
            "name": name,
            **loc(node),
            "params": params,
            "metrics": compute_metrics(node, body_node),
            "reads": [],
            "writes": [],
            "calls": [],
            "subscripts": [],
            "throws": [],
            "catches": [],
            "loops": [],
            "suspends": [],
        }

    def resolve_scope(name, scopes, owner_class):
        for s in reversed(scopes):
            if name in s:
                return s[name]
        if owner_class and name in class_fields.get(owner_class, {}):
            return class_fields[owner_class][name]
        if name in module_vars:
            return ("module", module_vars[name])
        return ("global", "unknown")

    def expr_scope(node, scopes, owner_class):
        if node is None:
            return ("unknown", None)
        if node.type == "this":
            return ("member", "this")
        if node.type == "identifier":
            sc, _ = resolve_scope(txt(node), scopes, owner_class)
            return (sc, txt(node))
        if node.type == "qualified_identifier":
            qname = txt(node)
            sc, _ = resolve_scope(qname, scopes, owner_class)
            return (sc, qname)
        return ("expr", None)

    def scan_locals(node, local_map):
        if node is None or node.type in ("lambda_expression", "function_definition"):
            return
        if node.type == "declaration":
            decl_kind, quals = decl_qualifiers(node)
            is_static = "static" in quals or "thread_local" in quals
            scope = "module" if is_static else "local"
            kind = "static" if is_static else decl_kind
            for d in node.children_by_field_name("declarator"):
                fid = first_id(d)
                if fid is not None:
                    vname = txt(fid)
                    local_map.setdefault(vname, (scope, kind))
                    if is_static:
                        declarations.append({
                            "kind": "variable",
                            "name": vname,
                            "bases": [],
                            "modifiers": ["static", decl_kind],
                            **loc(node),
                        })
        elif node.type == "for_range_loop":
            d = node.child_by_field_name("declarator")
            fid = first_id(d)
            if fid is not None:
                local_map.setdefault(txt(fid), ("local", "mutable"))
        elif node.type == "catch_clause":
            plist = node.child_by_field_name("parameters")
            if plist is not None:
                for c in plist.children:
                    if c.type in ("parameter_declaration", "optional_parameter_declaration"):
                        fid = first_id(c.child_by_field_name("declarator") or c)
                        if fid is not None:
                            local_map.setdefault(txt(fid), ("local", "mutable"))
        for c in node.children:
            scan_locals(c, local_map)

    functions_out = []

    def walk_body(fn_name, owner_class, fn_node, body_node, scopes):
        bucket = empty_bucket(fn_name, fn_node, fn_params(fn_node), body_node)
        functions_out.append(bucket)

        def record_write(target, node_loc, is_compound=False):
            root_node, wpath = unwrap_chain(target)
            pos = loc(node_loc)
            if root_node is not None and root_node.type == "this":
                bucket["writes"].append({
                    "target": txt(target),
                    "root": "this",
                    "scope": "member",
                    "path": wpath,
                    **pos,
                })
                if is_compound:
                    mem = f"this->{wpath[0]}" if wpath else "this"
                    bucket["reads"].append({"name": mem, "scope": "member", "decl": "mutable", **pos})
                return
            if root_node is not None and root_node.type in ("identifier", "qualified_identifier"):
                rname = txt(root_node)
                sc, decl_kind = resolve_scope(rname, scopes, owner_class)
                if sc != "local" or wpath:
                    bucket["writes"].append({
                        "target": txt(target),
                        "root": rname,
                        "scope": sc,
                        "path": wpath,
                        **pos,
                    })
                if is_compound and sc not in ("local", "param") and not wpath:
                    bucket["reads"].append({"name": rname, "scope": sc, "decl": decl_kind, **pos})
                return
            bucket["writes"].append({
                "target": txt(target),
                "root": txt(root_node) if root_node is not None else txt(target),
                "scope": "expr",
                "path": wpath,
                **pos,
            })

        def visit_write_subexprs(target):
            n = target
            while n is not None:
                if n.type == "subscript_expression":
                    idx = n.child_by_field_name("indices")
                    if idx is not None:
                        visit(idx)
                    n = n.child_by_field_name("argument") or n.child_by_field_name("value")
                elif n.type == "field_expression":
                    n = n.child_by_field_name("argument")
                elif n.type == "pointer_expression":
                    arg = n.child_by_field_name("argument")
                    if arg is not None and arg.type not in ("identifier", "qualified_identifier"):
                        visit(arg)
                    break
                elif n.type == "parenthesized_expression":
                    n = next((c for c in n.named_children), None)
                else:
                    if n.type not in ("identifier", "qualified_identifier", "this"):
                        visit(n)
                    break

        def visit_receiver_subexprs(node):
            n = node
            while n is not None:
                if n.type == "subscript_expression":
                    arg = n.child_by_field_name("argument") or n.child_by_field_name("value")
                    idx = n.child_by_field_name("indices")
                    root_arg, _ = unwrap_chain(arg)
                    sc, _ = expr_scope(root_arg, scopes, owner_class)
                    bucket["subscripts"].append({
                        "root": txt(arg),
                        "scope": sc,
                        "index": txt(idx).strip("[]"),
                        **loc(n),
                    })
                    if idx is not None:
                        visit(idx)
                    n = arg
                elif n.type == "field_expression":
                    n = n.child_by_field_name("argument")
                elif n.type == "parenthesized_expression":
                    n = next((c for c in n.named_children), None)
                else:
                    if n.type not in ("identifier", "qualified_identifier", "this"):
                        visit(n)
                    break

        def resolve_local_fn(name):
            if owner_class and f"{owner_class}::{name}" in fn_by_name:
                return f"{owner_class}::{name}"
            return fn_by_name.get(name)

        lambda_vars = {}
        if body_node is not None:
            def scan_lambda_vars(n):
                if n.type == "init_declarator":
                    val = n.child_by_field_name("value")
                    decl = n.child_by_field_name("declarator")
                    if val is not None and val.type == "lambda_expression" and (fid := first_id(decl)) is not None:
                        lpos = loc(val)
                        lambda_vars[txt(fid)] = f"{fn_name}/<fn>@{lpos['line']}:{lpos['col']}"
                if n.type not in ("lambda_expression", "function_definition"):
                    for c in n.children:
                        scan_lambda_vars(c)
            scan_lambda_vars(body_node)

        def visit(node):
            t = node.type
            if t in ("function_definition", "sizeof_expression", "alignof_expression"):
                return
            if t == "lambda_expression":
                lpos = loc(node)
                lname = f"{fn_name}/<fn>@{lpos['line']}:{lpos['col']}"
                lparams = fn_params(node)
                outer_closure = {}
                for s in scopes:
                    for k, (sc, dk) in s.items():
                        outer_closure[k] = (sc, dk) if sc == "module" else ("closure", "param" if sc == "param" else dk)
                llocals = {p: ("param", "param") for p in lparams}
                lbody = node.child_by_field_name("body")
                scan_locals(lbody, llocals)
                walk_body(lname, owner_class, node, lbody, (outer_closure, llocals))
                return

            if t == "assignment_expression":
                left = node.child_by_field_name("left")
                op = txt(node.child_by_field_name("operator"))
                record_write(left, node, is_compound=(op != "="))
                visit_write_subexprs(left)
                if (right := node.child_by_field_name("right")) is not None:
                    visit(right)
                return

            if t == "update_expression":
                arg = node.child_by_field_name("argument") or next((c for c in node.named_children), None)
                if arg is not None:
                    record_write(arg, node, is_compound=True)
                    visit_write_subexprs(arg)
                return

            if t == "call_expression":
                callee = node.child_by_field_name("function")
                pos = loc(node)
                if callee is None:
                    bucket["calls"].append({"expr": txt(node), "kind": "dynamic", "target": None, "resolved": False, **pos})
                elif callee.type == "identifier":
                    cname = txt(callee)
                    sc, _ = resolve_scope(cname, scopes, owner_class)
                    local_target = lambda_vars.get(cname) or resolve_local_fn(cname)
                    if sc == "param":
                        bucket["calls"].append({"expr": cname, "kind": "param", "target": None, "resolved": False, **pos})
                    elif local_target:
                        bucket["calls"].append({"expr": cname, "kind": "local", "target": local_target, "resolved": True, **pos})
                    elif sc in ("local", "closure", "member", "module"):
                        bucket["calls"].append({"expr": cname, "kind": "dynamic", "target": None, "resolved": False, **pos})
                    else:
                        bucket["calls"].append({"expr": cname, "kind": "external", "target": cname, "resolved": False, **pos})
                elif callee.type == "qualified_identifier":
                    qname = txt(callee)
                    local_target = resolve_local_fn(qname)
                    if local_target:
                        bucket["calls"].append({"expr": qname, "kind": "local", "target": local_target, "resolved": True, **pos})
                    else:
                        bucket["calls"].append({"expr": qname, "kind": "external", "target": qname, "resolved": False, **pos})
                elif callee.type == "template_function" and txt(callee.child_by_field_name("name")) in CAST_OPS:
                    if (args := node.child_by_field_name("arguments")) is not None:
                        for a in args.children:
                            visit(a)
                    return
                elif callee.type == "field_expression":
                    recv_node = callee.child_by_field_name("argument")
                    field_node = callee.child_by_field_name("field")
                    root_node, _ = unwrap_chain(recv_node)
                    recv_sc, recv_root = expr_scope(root_node, scopes, owner_class)
                    fname = txt(field_node)
                    local_target = resolve_local_fn(fname) if recv_sc == "member" else None
                    entry = {
                        "expr": txt(callee),
                        "kind": "local" if local_target else "opaque",
                        "target": local_target,
                        "resolved": bool(local_target),
                        "receiverScope": recv_sc,
                        **pos,
                    }
                    if recv_root:
                        entry["receiverRoot"] = recv_root
                    bucket["calls"].append(entry)
                    visit_receiver_subexprs(recv_node)
                else:
                    bucket["calls"].append({"expr": txt(callee), "kind": "dynamic", "target": None, "resolved": False, **pos})
                    visit(callee)
                if (args := node.child_by_field_name("arguments")) is not None:
                    for a in args.children:
                        visit(a)
                return

            if t == "throw_statement":
                bucket["throws"].append(loc(node))
            elif t == "catch_clause":
                bucket["catches"].append(loc(node))
            elif t == "while_statement":
                bucket["loops"].append({"kind": "while", **loc(node)})
            elif t == "do_statement":
                bucket["loops"].append({"kind": "do", **loc(node)})
            elif t == "for_statement" and node.child_by_field_name("condition") is None:
                bucket["loops"].append({"kind": "for(;;)", **loc(node)})
            elif t == "co_await_expression":
                bucket["suspends"].append({"kind": "co_await", **loc(node)})
            elif t == "co_yield_statement":
                bucket["suspends"].append({"kind": "co_yield", **loc(node)})
            elif t == "subscript_expression":
                arg = node.child_by_field_name("argument") or node.child_by_field_name("value")
                idx = node.child_by_field_name("indices")
                root_arg, _ = unwrap_chain(arg)
                sc, _ = expr_scope(root_arg, scopes, owner_class)
                bucket["subscripts"].append({
                    "root": txt(arg),
                    "scope": sc,
                    "index": txt(idx).strip("[]"),
                    **loc(node),
                })
            elif t == "field_expression" and node.child_by_field_name("argument") is not None and node.child_by_field_name("argument").type == "this":
                f = node.child_by_field_name("field")
                fname = txt(f)
                sc, dk = resolve_scope(fname, scopes, owner_class)
                bucket["reads"].append({"name": f"this->{fname}", "scope": "member", "decl": dk if sc == "member" else "unknown", **loc(node)})
                return
            elif t == "qualified_identifier" and is_value_read(node):
                qname = txt(node)
                sc, dk = resolve_scope(qname, scopes, owner_class)
                if sc not in ("local", "param"):
                    bucket["reads"].append({"name": qname, "scope": sc, "decl": dk, **loc(node)})
                return
            elif t == "identifier" and is_value_read(node):
                name = txt(node)
                sc, dk = resolve_scope(name, scopes, owner_class)
                if sc not in ("local", "param"):
                    bucket["reads"].append({"name": name, "scope": sc, "decl": dk, **loc(node)})

            for c in node.children:
                visit(c)

        if body_node is not None:
            visit(body_node)

    for qual, owner_class, fn_node in fn_defs:
        local_scope = {p: ("param", "param") for p in fn_params(fn_node)}
        body = fn_node.child_by_field_name("body")
        scan_locals(body, local_scope)
        walk_body(qual, owner_class, fn_node, body, (local_scope,))

    return {
        "file": file_str,
        "language": "cpp",
        "functions": functions_out,
        "declarations": declarations,
        "comments": {"count": len(comment_spans), "spans": comment_spans},
        "imports": imports,
        "hazards": hazards,
        "syntaxKinds": syntax_kinds,
    }


if __name__ == "__main__":
    print(json.dumps(observe(sys.argv[1]), indent=1))
