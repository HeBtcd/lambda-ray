use proc_macro2::{LineColumn, Span, TokenStream, TokenTree};
use quote::ToTokens;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process;
use syn::parse::Parser;
use syn::punctuated::Punctuated;
use syn::{
    BinOp, Block, Expr, ExprCall, ExprClosure, ExprField, ExprMethodCall, ExprPath, FnArg,
    ImplItem, Item, ItemFn, ItemImpl, ItemMod, ItemTrait, Local, Macro, Member, Pat, Path,
    StaticMutability, Stmt, Token, TraitItem, Type, UseTree,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RayOutput {
    file: String,
    language: &'static str,
    functions: Vec<FunctionBucket>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FunctionBucket {
    name: String,
    line: usize,
    col: usize,
    params: Vec<String>,
    reads: Vec<ReadFact>,
    writes: Vec<WriteFact>,
    calls: Vec<CallFact>,
    subscripts: Vec<SubscriptFact>,
    throws: Vec<LocFact>,
    catches: Vec<LocFact>,
    loops: Vec<KindLocFact>,
    suspends: Vec<KindLocFact>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadFact {
    name: String,
    scope: &'static str,
    decl: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    line: usize,
    col: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteFact {
    target: String,
    root: String,
    scope: &'static str,
    path: Vec<String>,
    line: usize,
    col: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CallFact {
    expr: String,
    kind: &'static str,
    target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    resolved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver_scope: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receiver_root: Option<String>,
    line: usize,
    col: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptFact {
    root: String,
    scope: &'static str,
    index: String,
    line: usize,
    col: usize,
}

#[derive(Serialize)]
struct LocFact {
    line: usize,
    col: usize,
}

#[derive(Serialize)]
struct KindLocFact {
    kind: &'static str,
    line: usize,
    col: usize,
}

#[derive(Clone)]
struct ImportInfo {
    from: String,
    orig: String,
}

#[derive(Clone)]
enum Binding {
    Local { decl: &'static str },
    Param,
    Closure { decl: &'static str },
    Module { decl: &'static str },
    Import(ImportInfo),
}

impl Binding {
    fn scope(&self) -> &'static str {
        match self {
            Binding::Local { .. } => "local",
            Binding::Param => "param",
            Binding::Closure { .. } => "closure",
            Binding::Module { .. } => "module",
            Binding::Import(_) => "import",
        }
    }

    fn decl(&self) -> &'static str {
        match self {
            Binding::Local { decl } => decl,
            Binding::Param => "param",
            Binding::Closure { decl } => decl,
            Binding::Module { decl } => decl,
            Binding::Import(_) => "import",
        }
    }
}

struct SourceText {
    src: String,
    line_starts: Vec<usize>,
}

impl SourceText {
    fn new(src: String) -> Self {
        let mut line_starts = vec![0usize];
        for (i, b) in src.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i + 1);
            }
        }
        Self { src, line_starts }
    }

    fn offset_of(&self, lc: LineColumn) -> Option<usize> {
        let line_idx = lc.line.checked_sub(1)?;
        let start = *self.line_starts.get(line_idx)?;
        let line_tail = &self.src[start..];
        let mut chars = line_tail.char_indices();
        for _ in 0..lc.column {
            if chars.next().is_none() {
                return Some(self.src.len());
            }
        }
        if let Some((rel, _)) = chars.next() {
            Some(start + rel)
        } else {
            Some(self.src.len())
        }
    }

    fn slice_span(&self, start: LineColumn, end: LineColumn) -> Option<String> {
        let s = self.offset_of(start)?;
        let e = self.offset_of(end)?;
        if e > s && e <= self.src.len() {
            Some(self.src[s..e].to_string())
        } else {
            None
        }
    }

    fn slice_tokens<T: ToTokens>(&self, node: &T) -> String {
        let ts = node.to_token_stream();
        if let Some((start, end)) = token_bounds(ts.clone())
            && let Some(text) = self.slice_span(start, end)
        {
            return text;
        }
        ts.to_string()
    }
}

fn cmp_lc(a: LineColumn, b: LineColumn) -> std::cmp::Ordering {
    (a.line, a.column).cmp(&(b.line, b.column))
}

fn extend_bounds(bounds: &mut Option<(LineColumn, LineColumn)>, s: LineColumn, e: LineColumn) {
    match bounds {
        None => *bounds = Some((s, e)),
        Some((cs, ce)) => {
            if cmp_lc(s, *cs) == std::cmp::Ordering::Less {
                *cs = s;
            }
            if cmp_lc(e, *ce) == std::cmp::Ordering::Greater {
                *ce = e;
            }
        }
    }
}

fn token_bounds(ts: TokenStream) -> Option<(LineColumn, LineColumn)> {
    let mut bounds: Option<(LineColumn, LineColumn)> = None;
    for tt in ts {
        match tt {
            TokenTree::Group(g) => {
                extend_bounds(&mut bounds, g.span_open().start(), g.span_close().end());
                if let Some((is, ie)) = token_bounds(g.stream()) {
                    extend_bounds(&mut bounds, is, ie);
                }
            }
            other => {
                let sp = other.span();
                extend_bounds(&mut bounds, sp.start(), sp.end());
            }
        }
    }
    bounds
}

fn loc_of_span(span: Span) -> (usize, usize) {
    let s = span.start();
    (s.line, s.column + 1)
}

fn node_start_lc<T: ToTokens>(node: &T) -> Option<LineColumn> {
    token_bounds(node.to_token_stream()).map(|(s, _)| s)
}

fn node_end_lc<T: ToTokens>(node: &T) -> Option<LineColumn> {
    token_bounds(node.to_token_stream()).map(|(_, e)| e)
}

fn loc_of_node<T: ToTokens>(node: &T) -> (usize, usize) {
    if let Some(s) = node_start_lc(node) {
        (s.line, s.column + 1)
    } else {
        (1, 1)
    }
}

fn qual_join(prefix: &[String], name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{}::{}", prefix.join("::"), name)
    }
}

fn path_base_name(path: &Path) -> String {
    path.segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

fn type_base_name(ty: &Type, src: &SourceText) -> String {
    match ty {
        Type::Path(tp) if tp.qself.is_none() => path_base_name(&tp.path),
        Type::Paren(p) => type_base_name(&p.elem, src),
        Type::Group(g) => type_base_name(&g.elem, src),
        other => src.slice_tokens(other),
    }
}

fn collect_use_tree(tree: &UseTree, prefix: &mut Vec<String>, out: &mut HashMap<String, ImportInfo>) {
    match tree {
        UseTree::Path(p) => {
            prefix.push(p.ident.to_string());
            collect_use_tree(&p.tree, prefix, out);
            prefix.pop();
        }
        UseTree::Group(g) => {
            for item in &g.items {
                collect_use_tree(item, prefix, out);
            }
        }
        UseTree::Name(n) => {
            let ident = n.ident.to_string();
            if ident == "self" {
                if let Some(last) = prefix.last().cloned() {
                    out.insert(
                        last,
                        ImportInfo {
                            from: prefix.join("::"),
                            orig: "self".to_string(),
                        },
                    );
                }
            } else {
                let from = if prefix.is_empty() {
                    ident.clone()
                } else {
                    prefix.join("::")
                };
                out.insert(
                    ident.clone(),
                    ImportInfo { from, orig: ident },
                );
            }
        }
        UseTree::Rename(r) => {
            let orig = r.ident.to_string();
            let rename = r.rename.to_string();
            if orig == "self" {
                out.insert(
                    rename,
                    ImportInfo {
                        from: prefix.join("::"),
                        orig: "self".to_string(),
                    },
                );
            } else {
                let from = if prefix.is_empty() {
                    orig.clone()
                } else {
                    prefix.join("::")
                };
                out.insert(rename, ImportInfo { from, orig });
            }
        }
        UseTree::Glob(_) => {}
    }
}

struct ModuleIndex {
    imports_by_mod: HashMap<String, HashMap<String, ImportInfo>>,
    vars_by_mod: HashMap<String, HashMap<String, &'static str>>,
    vars_qualified: HashMap<String, &'static str>,
    fns_by_mod: HashMap<String, HashMap<String, String>>,
    fn_targets: HashMap<String, String>,
    method_targets: HashMap<(String, String), String>,
}

impl ModuleIndex {
    fn new() -> Self {
        Self {
            imports_by_mod: HashMap::new(),
            vars_by_mod: HashMap::new(),
            vars_qualified: HashMap::new(),
            fns_by_mod: HashMap::new(),
            fn_targets: HashMap::new(),
            method_targets: HashMap::new(),
        }
    }

    fn collect_items(&mut self, items: &[Item], mod_prefix: &mut Vec<String>, src: &SourceText) {
        let mod_key = mod_prefix.join("::");
        for item in items {
            match item {
                Item::Use(u) => {
                    let map = self.imports_by_mod.entry(mod_key.clone()).or_default();
                    let mut p = Vec::new();
                    collect_use_tree(&u.tree, &mut p, map);
                }
                Item::Const(c) => {
                    let name = c.ident.to_string();
                    let qual = qual_join(mod_prefix, &name);
                    self.vars_by_mod
                        .entry(mod_key.clone())
                        .or_default()
                        .insert(name, "const");
                    self.vars_qualified.insert(qual, "const");
                }
                Item::Static(s) => {
                    let name = s.ident.to_string();
                    let qual = qual_join(mod_prefix, &name);
                    let decl = if matches!(s.mutability, StaticMutability::Mut(_)) {
                        "mutable"
                    } else {
                        "static"
                    };
                    self.vars_by_mod
                        .entry(mod_key.clone())
                        .or_default()
                        .insert(name, decl);
                    self.vars_qualified.insert(qual, decl);
                }
                Item::Fn(f) => {
                    let name = f.sig.ident.to_string();
                    let qual = qual_join(mod_prefix, &name);
                    self.fns_by_mod
                        .entry(mod_key.clone())
                        .or_default()
                        .insert(name, qual.clone());
                    self.fn_targets.insert(qual.clone(), qual);
                }
                Item::Impl(imp) => {
                    let owner = qual_join(mod_prefix, &type_base_name(&imp.self_ty, src));
                    let trait_name = imp.trait_.as_ref().map(|(_, p, _)| path_base_name(p));
                    for impl_item in &imp.items {
                        if let ImplItem::Fn(m) = impl_item {
                            let mname = m.sig.ident.to_string();
                            let full = match &trait_name {
                                Some(tr) => format!("<{owner} as {tr}>::{mname}"),
                                None => format!("{owner}::{mname}"),
                            };
                            self.fn_targets.insert(full.clone(), full.clone());
                            self.method_targets
                                .entry((owner.clone(), mname))
                                .or_insert(full);
                        }
                    }
                }
                Item::Trait(tr) => {
                    let owner = qual_join(mod_prefix, &tr.ident.to_string());
                    for trait_item in &tr.items {
                        if let TraitItem::Fn(m) = trait_item
                            && m.default.is_some()
                        {
                            let mname = m.sig.ident.to_string();
                            let full = format!("{owner}::{mname}");
                            self.fn_targets.insert(full.clone(), full.clone());
                            self.method_targets
                                .entry((owner.clone(), mname))
                                .or_insert(full);
                        }
                    }
                }
                Item::Mod(m) => {
                    if let Some((_, inner)) = &m.content {
                        mod_prefix.push(m.ident.to_string());
                        self.collect_items(inner, mod_prefix, src);
                        mod_prefix.pop();
                    }
                }
                _ => {}
            }
        }
    }
}

struct FnContext<'a> {
    index: &'a ModuleIndex,
    src: &'a SourceText,
    mod_prefix: &'a [String],
    owner_type: Option<String>,
    fn_name: String,
    self_member_decl: &'static str,
    scopes: Vec<HashMap<String, Binding>>,
    local_fn_scopes: Vec<HashMap<String, String>>,
    closure_vars: Vec<HashMap<String, String>>,
    bucket: FunctionBucket,
    children: Vec<FunctionBucket>,
}

impl<'a> FnContext<'a> {
    fn mod_key(&self) -> String {
        self.mod_prefix.join("::")
    }

    fn resolve_value_with_closure(&self, name: &str) -> Option<(Binding, Option<String>)> {
        for (frame, cv) in self.scopes.iter().zip(self.closure_vars.iter()).rev() {
            if let Some(b) = frame.get(name) {
                let ct = if matches!(b, Binding::Local { .. }) {
                    cv.get(name).cloned()
                } else {
                    None
                };
                return Some((b.clone(), ct));
            }
        }
        let mk = self.mod_key();
        if let Some(vars) = self.index.vars_by_mod.get(&mk)
            && let Some(&decl) = vars.get(name)
        {
            return Some((Binding::Module { decl }, None));
        }
        if let Some(imps) = self.index.imports_by_mod.get(&mk)
            && let Some(info) = imps.get(name)
        {
            return Some((Binding::Import(info.clone()), None));
        }
        None
    }

    fn resolve_value(&self, name: &str) -> Option<Binding> {
        self.resolve_value_with_closure(name).map(|(b, _)| b)
    }

    fn resolve_local_fn(&self, name: &str) -> Option<String> {
        for frame in self.local_fn_scopes.iter().rev() {
            if let Some(t) = frame.get(name) {
                return Some(t.clone());
            }
        }
        let mk = self.mod_key();
        if let Some(fns) = self.index.fns_by_mod.get(&mk)
            && let Some(t) = fns.get(name)
        {
            return Some(t.clone());
        }
        if let Some(t) = self.index.fn_targets.get(name) {
            return Some(t.clone());
        }
        None
    }

    fn resolve_qualified_fn(&self, clean: &str) -> Option<String> {
        if let Some(rest) = clean.strip_prefix("Self::")
            && let Some(owner) = &self.owner_type
            && let Some(t) = self.index.method_targets.get(&(owner.clone(), rest.to_string()))
        {
            return Some(t.clone());
        }
        let in_mod = qual_join(self.mod_prefix, clean);
        if let Some(t) = self.index.fn_targets.get(&in_mod) {
            return Some(t.clone());
        }
        self.index.fn_targets.get(clean).cloned()
    }

    fn is_known_const_or_import(&self, name: &str) -> bool {
        let mk = self.mod_key();
        self.index
            .vars_by_mod
            .get(&mk)
            .is_some_and(|v| v.contains_key(name))
            || self
                .index
                .imports_by_mod
                .get(&mk)
                .is_some_and(|i| i.contains_key(name))
    }

    fn current_scope_mut(&mut self) -> &mut HashMap<String, Binding> {
        self.scopes.last_mut().expect("active scope")
    }

    fn push_scope(&mut self) {
        self.scopes.push(HashMap::new());
        self.local_fn_scopes.push(HashMap::new());
        self.closure_vars.push(HashMap::new());
    }

    fn pop_scope(&mut self) {
        self.scopes.pop();
        self.local_fn_scopes.pop();
        self.closure_vars.pop();
    }

    fn bind_pat(&mut self, pat: &Pat, as_param: bool, match_pat: bool) {
        match pat {
            Pat::Ident(pi) => {
                let name = pi.ident.to_string();
                if match_pat
                    && pi.mutability.is_none()
                    && pi.by_ref.is_none()
                    && pi.subpat.is_none()
                    && (name
                        .chars()
                        .next()
                        .is_some_and(|c| c.is_ascii_uppercase())
                        || self.is_known_const_or_import(&name))
                {
                    return;
                }
                let binding = if as_param {
                    Binding::Param
                } else if pi.mutability.is_some() {
                    Binding::Local { decl: "mutable" }
                } else {
                    Binding::Local { decl: "const" }
                };
                self.current_scope_mut().insert(name.clone(), binding);
                if let Some(cv) = self.closure_vars.last_mut() {
                    cv.remove(&name);
                }
                if let Some((_, sub)) = &pi.subpat {
                    self.bind_pat(sub, as_param, match_pat);
                }
            }
            Pat::Tuple(pt) => {
                for elem in &pt.elems {
                    self.bind_pat(elem, as_param, match_pat);
                }
            }
            Pat::Slice(ps) => {
                for elem in &ps.elems {
                    self.bind_pat(elem, as_param, match_pat);
                }
            }
            Pat::Struct(ps) => {
                for field in &ps.fields {
                    self.bind_pat(&field.pat, as_param, match_pat);
                }
            }
            Pat::TupleStruct(pts) => {
                for elem in &pts.elems {
                    self.bind_pat(elem, as_param, match_pat);
                }
            }
            Pat::Or(po) => {
                for case in &po.cases {
                    self.bind_pat(case, as_param, match_pat);
                }
            }
            Pat::Reference(pr) => self.bind_pat(&pr.pat, as_param, match_pat),
            Pat::Type(pt) => self.bind_pat(&pt.pat, as_param, match_pat),
            Pat::Paren(pp) => self.bind_pat(&pp.pat, as_param, match_pat),
            _ => {}
        }
    }

    fn precollect_block(&mut self, block: &Block) -> HashSet<String> {
        let mut local_fn_names = HashSet::new();
        for stmt in &block.stmts {
            if let Stmt::Item(item) = stmt {
                match item {
                    Item::Use(u) => {
                        let mut imps = HashMap::new();
                        let mut p = Vec::new();
                        collect_use_tree(&u.tree, &mut p, &mut imps);
                        for (k, v) in imps {
                            self.current_scope_mut().insert(k, Binding::Import(v));
                        }
                    }
                    Item::Const(c) => {
                        self.current_scope_mut()
                            .insert(c.ident.to_string(), Binding::Local { decl: "const" });
                    }
                    Item::Static(s) => {
                        let decl = if matches!(s.mutability, StaticMutability::Mut(_)) {
                            "mutable"
                        } else {
                            "static"
                        };
                        self.current_scope_mut()
                            .insert(s.ident.to_string(), Binding::Module { decl });
                    }
                    Item::Fn(f) => {
                        let fname = f.sig.ident.to_string();
                        let full = format!("{}/{}", self.fn_name, fname);
                        local_fn_names.insert(fname.clone());
                        if let Some(frame) = self.local_fn_scopes.last_mut() {
                            frame.insert(fname, full);
                        }
                    }
                    _ => {}
                }
            }
        }
        local_fn_names
    }

    fn visit_block(&mut self, block: &Block) {
        self.push_scope();
        self.precollect_block(block);
        for stmt in &block.stmts {
            self.visit_stmt(stmt);
        }
        self.pop_scope();
    }

    fn visit_stmt(&mut self, stmt: &Stmt) {
        match stmt {
            Stmt::Local(local) => self.visit_local(local),
            Stmt::Item(item) => self.visit_inner_item(item),
            Stmt::Expr(expr, _) => self.visit_expr(expr),
            Stmt::Macro(m) => self.visit_macro(&m.mac),
        }
    }

    fn visit_inner_item(&mut self, item: &Item) {
        match item {
            Item::Fn(f) => {
                let child_name = format!("{}/{}", self.fn_name, f.sig.ident);
                let mut item_frame = HashMap::new();
                for frame in &self.scopes {
                    for (k, b) in frame {
                        if matches!(b, Binding::Module { .. } | Binding::Import(_)) {
                            item_frame.insert(k.clone(), b.clone());
                        }
                    }
                }
                let (line, col) = loc_of_node(f);
                let env = WalkEnv {
                    index: self.index,
                    src: self.src,
                    mod_prefix: self.mod_prefix,
                };
                let mut child = walk_signature_and_block(
                    &env,
                    WalkTarget {
                        owner_type: self.owner_type.clone(),
                        fn_name: child_name,
                        line,
                        col,
                    },
                    &f.sig,
                    &f.block,
                    vec![item_frame],
                    self.local_fn_scopes.clone(),
                );
                self.children.append(&mut child);
            }
            Item::Const(c) => {
                self.visit_expr(&c.expr);
            }
            Item::Static(s) => {
                self.visit_expr(&s.expr);
            }
            _ => {}
        }
    }

    fn visit_local(&mut self, local: &Local) {
        let mut bound_closure_target: Option<(String, String)> = None;
        if let Some(init) = &local.init {
            if let Expr::Closure(c) = unwrap_paren(&init.expr)
                && let Some(ident) = simple_pat_ident(&local.pat)
            {
                let cname = format!("{}/{}", self.fn_name, ident);
                self.visit_closure(c, Some(cname.clone()));
                bound_closure_target = Some((ident, cname));
            } else {
                self.visit_expr(&init.expr);
            }
            if let Some((_, diverge)) = &init.diverge {
                self.visit_expr(diverge);
            }
        }
        self.bind_pat(&local.pat, false, false);
        if let Some((ident, cname)) = bound_closure_target
            && let Some(cv) = self.closure_vars.last_mut()
        {
            cv.insert(ident, cname);
        }
    }

    fn visit_closure(&mut self, closure: &ExprClosure, explicit_name: Option<String>) {
        let (line, col) = loc_of_node(closure);
        let name = explicit_name.unwrap_or_else(|| format!("{}/<fn>@{line}:{col}", self.fn_name));

        let mut outer_frame: HashMap<String, Binding> = HashMap::new();
        for frame in &self.scopes {
            for (k, b) in frame {
                let captured = match b {
                    Binding::Local { decl } => Binding::Closure { decl },
                    Binding::Param => Binding::Closure { decl: "param" },
                    Binding::Closure { decl } => Binding::Closure { decl },
                    Binding::Module { decl } => Binding::Module { decl },
                    Binding::Import(i) => Binding::Import(i.clone()),
                };
                outer_frame.insert(k.clone(), captured);
            }
        }
        let outer_fns = self.local_fn_scopes.clone();

        let mut params = Vec::new();
        let mut param_frame = HashMap::new();
        for pat in &closure.inputs {
            params.push(param_text_from_pat(pat, self.src));
            collect_pat_bindings(pat, &mut param_frame);
        }

        let bucket = empty_bucket(name.clone(), line, col, params);
        let mut child_ctx = FnContext {
            index: self.index,
            src: self.src,
            mod_prefix: self.mod_prefix,
            owner_type: self.owner_type.clone(),
            fn_name: name,
            self_member_decl: self.self_member_decl,
            scopes: vec![outer_frame, param_frame],
            local_fn_scopes: outer_fns,
            closure_vars: vec![HashMap::new(), HashMap::new()],
            bucket,
            children: Vec::new(),
        };
        child_ctx.visit_expr(&closure.body);
        self.children.push(child_ctx.bucket);
        self.children.extend(child_ctx.children);
    }

    fn expr_root_scope(&self, expr: &Expr) -> (&'static str, Option<String>) {
        let u = unwrap_paren(expr);
        if is_self_expr(u) {
            return ("member", Some("self".to_string()));
        }
        if let Expr::Path(ep) = u
            && ep.qself.is_none()
        {
            if ep.path.segments.len() == 1 {
                let ident = ep.path.segments[0].ident.to_string();
                let sc = self
                    .resolve_value(&ident)
                    .map(|b| b.scope())
                    .unwrap_or("global");
                return (sc, Some(ident));
            }
            let clean = path_base_name(&ep.path);
            let sc = self.resolve_multi_path(&clean).0;
            return (sc, Some(clean));
        }
        ("expr", None)
    }

    fn resolve_multi_path(&self, clean: &str) -> (&'static str, &'static str, Option<String>) {
        if let Some(&decl) = self.index.vars_qualified.get(clean) {
            return ("module", decl, None);
        }
        let in_mod = qual_join(self.mod_prefix, clean);
        if let Some(&decl) = self.index.vars_qualified.get(&in_mod) {
            return ("module", decl, None);
        }
        if self.index.fn_targets.contains_key(clean)
            || self.index.fn_targets.contains_key(&in_mod)
        {
            return ("module", "function", None);
        }
        if let Some(first) = clean.split("::").next()
            && let Some(Binding::Import(info)) = self.resolve_value(first)
        {
            return ("import", "import", Some(info.from));
        }
        ("global", "unknown", None)
    }

    fn record_write(&mut self, target: &Expr, is_compound: bool) {
        let u = unwrap_paren(target);
        match u {
            Expr::Infer(_) => return,
            Expr::Tuple(t) => {
                for elem in &t.elems {
                    self.record_write(elem, is_compound);
                }
                return;
            }
            Expr::Array(a) => {
                for elem in &a.elems {
                    self.record_write(elem, is_compound);
                }
                return;
            }
            _ => {}
        }

        let (root_expr, path) = unwrap_write_chain(u);
        let (line, col) = loc_of_node(target);
        let target_text = self.src.slice_tokens(target);

        if is_self_expr(root_expr) {
            self.bucket.writes.push(WriteFact {
                target: target_text,
                root: "self".to_string(),
                scope: "member",
                path: path.clone(),
                line,
                col,
            });
            if is_compound {
                let mem = match path.first() {
                    Some(f) if f != "(index)" && f != "*" => format!("self.{f}"),
                    _ => "self".to_string(),
                };
                self.bucket.reads.push(ReadFact {
                    name: mem,
                    scope: "member",
                    decl: "mutable",
                    from: None,
                    line,
                    col,
                });
            }
            return;
        }

        if let Expr::Path(ep) = root_expr
            && ep.qself.is_none()
        {
            if ep.path.segments.len() == 1 {
                let ident = ep.path.segments[0].ident.to_string();
                let resolved = self.resolve_value(&ident);
                let sc = resolved.as_ref().map(|b| b.scope()).unwrap_or("global");
                let decl = resolved.as_ref().map(|b| b.decl()).unwrap_or("unknown");
                let from = match &resolved {
                    Some(Binding::Import(info)) => Some(info.from.clone()),
                    _ => None,
                };
                if sc != "local" || !path.is_empty() {
                    self.bucket.writes.push(WriteFact {
                        target: target_text,
                        root: ident.clone(),
                        scope: sc,
                        path: path.clone(),
                        line,
                        col,
                    });
                }
                if is_compound && sc != "local" && sc != "param" && path.is_empty() {
                    self.bucket.reads.push(ReadFact {
                        name: ident,
                        scope: sc,
                        decl,
                        from,
                        line,
                        col,
                    });
                }
                return;
            }
            let clean = path_base_name(&ep.path);
            let (sc, decl, from) = self.resolve_multi_path(&clean);
            self.bucket.writes.push(WriteFact {
                target: target_text,
                root: clean.clone(),
                scope: sc,
                path: path.clone(),
                line,
                col,
            });
            if is_compound && path.is_empty() {
                self.bucket.reads.push(ReadFact {
                    name: clean,
                    scope: sc,
                    decl,
                    from,
                    line,
                    col,
                });
            }
            return;
        }

        let root_text = self.src.slice_tokens(root_expr);
        self.bucket.writes.push(WriteFact {
            target: target_text,
            root: root_text,
            scope: "expr",
            path,
            line,
            col,
        });
    }

    fn visit_write_subexprs(&mut self, target: &Expr) {
        let mut cur = unwrap_paren(target);
        match cur {
            Expr::Infer(_) => return,
            Expr::Tuple(t) => {
                for elem in &t.elems {
                    self.visit_write_subexprs(elem);
                }
                return;
            }
            Expr::Array(a) => {
                for elem in &a.elems {
                    self.visit_write_subexprs(elem);
                }
                return;
            }
            _ => {}
        }
        loop {
            match unwrap_paren(cur) {
                Expr::Index(idx) => {
                    self.visit_expr(&idx.index);
                    cur = &idx.expr;
                }
                Expr::Field(f) => {
                    cur = &f.base;
                }
                Expr::Unary(u) if matches!(u.op, syn::UnOp::Deref(_)) => {
                    cur = &u.expr;
                }
                other => {
                    if !is_self_expr(other) && !matches!(other, Expr::Path(ep) if ep.qself.is_none())
                    {
                        self.visit_expr(other);
                    }
                    break;
                }
            }
        }
    }

    fn visit_receiver_subexprs(&mut self, recv: &Expr) {
        let mut cur = unwrap_paren(recv);
        loop {
            match unwrap_paren(cur) {
                Expr::Index(idx) => {
                    let (root_base, _) = unwrap_write_chain(&idx.expr);
                    let (sc, _) = self.expr_root_scope(root_base);
                    let (line, col) = loc_of_node(idx);
                    self.bucket.subscripts.push(SubscriptFact {
                        root: self.src.slice_tokens(&idx.expr),
                        scope: sc,
                        index: self.src.slice_tokens(&idx.index),
                        line,
                        col,
                    });
                    self.visit_expr(&idx.index);
                    cur = &idx.expr;
                }
                Expr::Field(f) => {
                    cur = &f.base;
                }
                Expr::Unary(u) if matches!(u.op, syn::UnOp::Deref(_)) => {
                    cur = &u.expr;
                }
                other => {
                    if !is_self_expr(other)
                        && !matches!(other, Expr::Path(ep) if ep.qself.is_none() && ep.path.segments.len() == 1)
                    {
                        self.visit_expr(other);
                    }
                    break;
                }
            }
        }
    }

    fn record_call(&mut self, call: &ExprCall) {
        let callee = unwrap_paren(&call.func);
        let (line, col) = loc_of_node(call);

        if let Expr::Path(ep) = callee
            && ep.qself.is_none()
        {
            if ep.path.segments.len() == 1 {
                let name = ep.path.segments[0].ident.to_string();
                if let Some((binding, closure_target)) = self.resolve_value_with_closure(&name) {
                    match binding {
                        Binding::Param => {
                            self.bucket.calls.push(CallFact {
                                expr: name,
                                kind: "param",
                                target: None,
                                from: None,
                                resolved: false,
                                receiver_scope: None,
                                receiver_root: None,
                                line,
                                col,
                            });
                            return;
                        }
                        Binding::Local { .. } => {
                            if let Some(ct) = closure_target {
                                self.bucket.calls.push(CallFact {
                                    expr: name,
                                    kind: "local",
                                    target: Some(ct),
                                    from: None,
                                    resolved: true,
                                    receiver_scope: None,
                                    receiver_root: None,
                                    line,
                                    col,
                                });
                            } else {
                                self.bucket.calls.push(CallFact {
                                    expr: name,
                                    kind: "dynamic",
                                    target: None,
                                    from: None,
                                    resolved: false,
                                    receiver_scope: None,
                                    receiver_root: None,
                                    line,
                                    col,
                                });
                            }
                            return;
                        }
                        Binding::Closure { .. } | Binding::Module { .. } => {
                            self.bucket.calls.push(CallFact {
                                expr: name,
                                kind: "dynamic",
                                target: None,
                                from: None,
                                resolved: false,
                                receiver_scope: None,
                                receiver_root: None,
                                line,
                                col,
                            });
                            return;
                        }
                        Binding::Import(info) => {
                            self.bucket.calls.push(CallFact {
                                expr: name,
                                kind: "import",
                                target: Some(format!("{}#{}", info.from, info.orig)),
                                from: Some(info.from),
                                resolved: true,
                                receiver_scope: None,
                                receiver_root: None,
                                line,
                                col,
                            });
                            return;
                        }
                    }
                }
                if let Some(local_target) = self.resolve_local_fn(&name) {
                    self.bucket.calls.push(CallFact {
                        expr: name,
                        kind: "local",
                        target: Some(local_target),
                        from: None,
                        resolved: true,
                        receiver_scope: None,
                        receiver_root: None,
                        line,
                        col,
                    });
                    return;
                }
                self.bucket.calls.push(CallFact {
                    expr: name.clone(),
                    kind: "external",
                    target: Some(name),
                    from: None,
                    resolved: false,
                    receiver_scope: None,
                    receiver_root: None,
                    line,
                    col,
                });
                return;
            }

            let expr_text = self.src.slice_tokens(callee);
            let clean = path_base_name(&ep.path);
            if let Some(local_target) = self.resolve_qualified_fn(&clean) {
                self.bucket.calls.push(CallFact {
                    expr: expr_text,
                    kind: "local",
                    target: Some(local_target),
                    from: None,
                    resolved: true,
                    receiver_scope: None,
                    receiver_root: None,
                    line,
                    col,
                });
                return;
            }
            let first = ep.path.segments[0].ident.to_string();
            if let Some(Binding::Import(info)) = self.resolve_value(&first) {
                let imp_from = if info.orig == "self" {
                    info.from
                } else {
                    format!("{}::{}", info.from, info.orig)
                };
                let rest = ep
                    .path
                    .segments
                    .iter()
                    .skip(1)
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::");
                self.bucket.calls.push(CallFact {
                    expr: expr_text,
                    kind: "import",
                    target: Some(format!("{imp_from}#{rest}")),
                    from: Some(imp_from),
                    resolved: true,
                    receiver_scope: None,
                    receiver_root: None,
                    line,
                    col,
                });
                return;
            }
            self.bucket.calls.push(CallFact {
                expr: expr_text,
                kind: "external",
                target: Some(clean),
                from: None,
                resolved: false,
                receiver_scope: None,
                receiver_root: None,
                line,
                col,
            });
            return;
        }

        self.bucket.calls.push(CallFact {
            expr: self.src.slice_tokens(callee),
            kind: "dynamic",
            target: None,
            from: None,
            resolved: false,
            receiver_scope: None,
            receiver_root: None,
            line,
            col,
        });
        self.visit_expr(&call.func);
    }

    fn record_method_call(&mut self, mc: &ExprMethodCall) {
        let (line, col) = loc_of_node(mc);
        let expr_text = match (node_start_lc(&mc.receiver), node_end_lc(&mc.method)) {
            (Some(s), Some(e)) => self
                .src
                .slice_span(s, e)
                .unwrap_or_else(|| format!("{}.{}", self.src.slice_tokens(&mc.receiver), mc.method)),
            _ => format!("{}.{}", self.src.slice_tokens(&mc.receiver), mc.method),
        };
        let method_name = mc.method.to_string();
        let (recv_chain_root, recv_path) = unwrap_write_chain(&mc.receiver);
        let (recv_sc, recv_root) = self.expr_root_scope(recv_chain_root);

        if recv_path.is_empty()
            && is_self_expr(recv_chain_root)
            && let Some(owner) = &self.owner_type
            && let Some(target) = self
                .index
                .method_targets
                .get(&(owner.clone(), method_name.clone()))
        {
            self.bucket.calls.push(CallFact {
                expr: expr_text,
                kind: "local",
                target: Some(target.clone()),
                from: None,
                resolved: true,
                receiver_scope: Some("member"),
                receiver_root: Some("self".to_string()),
                line,
                col,
            });
            self.visit_receiver_subexprs(&mc.receiver);
            return;
        }

        if let Some(root_ident) = &recv_root
            && recv_sc == "import"
            && let Some(Binding::Import(info)) = self.resolve_value(root_ident)
        {
            self.bucket.calls.push(CallFact {
                expr: expr_text,
                kind: "import",
                target: Some(format!("{}#{}.{}", info.from, info.orig, method_name)),
                from: Some(info.from),
                resolved: true,
                receiver_scope: Some("import"),
                receiver_root: Some(root_ident.clone()),
                line,
                col,
            });
            self.visit_receiver_subexprs(&mc.receiver);
            return;
        }

        self.bucket.calls.push(CallFact {
            expr: expr_text,
            kind: "opaque",
            target: None,
            from: None,
            resolved: false,
            receiver_scope: Some(recv_sc),
            receiver_root: recv_root,
            line,
            col,
        });
        self.visit_receiver_subexprs(&mc.receiver);
    }

    fn visit_macro(&mut self, mac: &Macro) {
        let (line, col) = loc_of_node(&mac.path);
        let full = format!("{}!", path_base_name(&mac.path));
        let last = mac
            .path
            .segments
            .last()
            .map(|s| s.ident.to_string())
            .unwrap_or_default();

        if matches!(
            last.as_str(),
            "panic"
                | "todo"
                | "unimplemented"
                | "unreachable"
                | "assert"
                | "assert_eq"
                | "assert_ne"
                | "debug_assert"
                | "debug_assert_eq"
                | "debug_assert_ne"
        ) {
            self.bucket.throws.push(LocFact { line, col });
        } else {
            self.bucket.calls.push(CallFact {
                expr: full.clone(),
                kind: "external",
                target: Some(full),
                from: None,
                resolved: false,
                receiver_scope: None,
                receiver_root: None,
                line,
                col,
            });
        }

        if let Ok(args) = Parser::parse2(
            Punctuated::<Expr, Token![,]>::parse_terminated,
            mac.tokens.clone(),
        ) {
            for arg in &args {
                self.visit_expr(arg);
            }
        } else if let Ok(args) = Parser::parse2(
            Punctuated::<Expr, Token![;]>::parse_terminated,
            mac.tokens.clone(),
        ) {
            for arg in &args {
                self.visit_expr(arg);
            }
        }
    }

    fn visit_path_read(&mut self, ep: &ExprPath) {
        if ep.qself.is_some() {
            return;
        }
        let (line, col) = loc_of_node(ep);
        if ep.path.segments.len() == 1 {
            let name = ep.path.segments[0].ident.to_string();
            if name == "self" || name == "Self" {
                return;
            }
            if let Some(b) = self.resolve_value(&name) {
                match b {
                    Binding::Local { .. } | Binding::Param => {}
                    Binding::Closure { decl } => {
                        self.bucket.reads.push(ReadFact {
                            name,
                            scope: "closure",
                            decl,
                            from: None,
                            line,
                            col,
                        });
                    }
                    Binding::Module { decl } => {
                        self.bucket.reads.push(ReadFact {
                            name,
                            scope: "module",
                            decl,
                            from: None,
                            line,
                            col,
                        });
                    }
                    Binding::Import(info) => {
                        self.bucket.reads.push(ReadFact {
                            name,
                            scope: "import",
                            decl: "import",
                            from: Some(info.from),
                            line,
                            col,
                        });
                    }
                }
                return;
            }
            if self.resolve_local_fn(&name).is_some() {
                self.bucket.reads.push(ReadFact {
                    name,
                    scope: "module",
                    decl: "function",
                    from: None,
                    line,
                    col,
                });
                return;
            }
            self.bucket.reads.push(ReadFact {
                name,
                scope: "global",
                decl: "unknown",
                from: None,
                line,
                col,
            });
            return;
        }

        let clean = path_base_name(&ep.path);
        let (sc, decl, from) = self.resolve_multi_path(&clean);
        self.bucket.reads.push(ReadFact {
            name: clean,
            scope: sc,
            decl,
            from,
            line,
            col,
        });
    }

    fn visit_expr(&mut self, expr: &Expr) {
        match expr {
            Expr::Assign(e) => {
                self.record_write(&e.left, false);
                self.visit_write_subexprs(&e.left);
                self.visit_expr(&e.right);
            }
            Expr::Binary(e) => {
                if is_compound_assign(e.op) {
                    self.record_write(&e.left, true);
                    self.visit_write_subexprs(&e.left);
                    self.visit_expr(&e.right);
                } else {
                    self.visit_expr(&e.left);
                    self.visit_expr(&e.right);
                }
            }
            Expr::Call(e) => {
                self.record_call(e);
                for arg in &e.args {
                    self.visit_expr(arg);
                }
            }
            Expr::MethodCall(e) => {
                self.record_method_call(e);
                for arg in &e.args {
                    self.visit_expr(arg);
                }
            }
            Expr::Macro(e) => {
                self.visit_macro(&e.mac);
            }
            Expr::Try(e) => {
                let (line, col) = loc_of_span(e.question_token.span);
                self.bucket.throws.push(LocFact { line, col });
                self.visit_expr(&e.expr);
            }
            Expr::Await(e) => {
                let (line, col) = loc_of_span(e.await_token.span);
                self.bucket.suspends.push(KindLocFact {
                    kind: "await",
                    line,
                    col,
                });
                self.visit_expr(&e.base);
            }
            Expr::Yield(e) => {
                let (line, col) = loc_of_span(e.yield_token.span);
                self.bucket.suspends.push(KindLocFact {
                    kind: "yield",
                    line,
                    col,
                });
                if let Some(inner) = &e.expr {
                    self.visit_expr(inner);
                }
            }
            Expr::While(e) => {
                let (line, col) = loc_of_span(e.while_token.span);
                self.bucket.loops.push(KindLocFact {
                    kind: "while",
                    line,
                    col,
                });
                self.push_scope();
                self.visit_expr(&e.cond);
                self.visit_block(&e.body);
                self.pop_scope();
            }
            Expr::Loop(e) => {
                let (line, col) = loc_of_span(e.loop_token.span);
                self.bucket.loops.push(KindLocFact {
                    kind: "loop",
                    line,
                    col,
                });
                self.visit_block(&e.body);
            }
            Expr::ForLoop(e) => {
                self.visit_expr(&e.expr);
                self.push_scope();
                self.bind_pat(&e.pat, false, false);
                self.visit_block(&e.body);
                self.pop_scope();
            }
            Expr::Let(e) => {
                self.visit_expr(&e.expr);
                self.bind_pat(&e.pat, false, true);
            }
            Expr::If(e) => {
                self.push_scope();
                self.visit_expr(&e.cond);
                self.visit_block(&e.then_branch);
                self.pop_scope();
                if let Some((_, else_expr)) = &e.else_branch {
                    self.push_scope();
                    self.visit_expr(else_expr);
                    self.pop_scope();
                }
            }
            Expr::Match(e) => {
                self.visit_expr(&e.expr);
                for arm in &e.arms {
                    self.push_scope();
                    self.bind_pat(&arm.pat, false, true);
                    if let Some((_, guard)) = &arm.guard {
                        self.visit_expr(guard);
                    }
                    self.visit_expr(&arm.body);
                    self.pop_scope();
                }
            }
            Expr::Block(e) => self.visit_block(&e.block),
            Expr::Async(e) => self.visit_block(&e.block),
            Expr::Unsafe(e) => self.visit_block(&e.block),
            Expr::TryBlock(e) => self.visit_block(&e.block),
            Expr::Const(e) => self.visit_block(&e.block),
            Expr::Closure(e) => self.visit_closure(e, None),
            Expr::Index(e) => {
                let (root_node, _) = unwrap_write_chain(&e.expr);
                let (sc, _) = self.expr_root_scope(root_node);
                let (line, col) = loc_of_node(e);
                self.bucket.subscripts.push(SubscriptFact {
                    root: self.src.slice_tokens(&e.expr),
                    scope: sc,
                    index: self.src.slice_tokens(&e.index),
                    line,
                    col,
                });
                self.visit_expr(&e.expr);
                self.visit_expr(&e.index);
            }
            Expr::Field(e) => self.visit_field_read(e),
            Expr::Path(e) => self.visit_path_read(e),
            Expr::Struct(e) => {
                for field in &e.fields {
                    if field.colon_token.is_none() {
                        if let Member::Named(ident) = &field.member {
                            let name = ident.to_string();
                            let (line, col) = loc_of_span(ident.span());
                            if let Some(b) = self.resolve_value(&name) {
                                match b {
                                    Binding::Local { .. } | Binding::Param => {}
                                    Binding::Closure { decl } => {
                                        self.bucket.reads.push(ReadFact {
                                            name,
                                            scope: "closure",
                                            decl,
                                            from: None,
                                            line,
                                            col,
                                        });
                                    }
                                    Binding::Module { decl } => {
                                        self.bucket.reads.push(ReadFact {
                                            name,
                                            scope: "module",
                                            decl,
                                            from: None,
                                            line,
                                            col,
                                        });
                                    }
                                    Binding::Import(info) => {
                                        self.bucket.reads.push(ReadFact {
                                            name,
                                            scope: "import",
                                            decl: "import",
                                            from: Some(info.from),
                                            line,
                                            col,
                                        });
                                    }
                                }
                            } else {
                                self.bucket.reads.push(ReadFact {
                                    name,
                                    scope: "global",
                                    decl: "unknown",
                                    from: None,
                                    line,
                                    col,
                                });
                            }
                        }
                    } else {
                        self.visit_expr(&field.expr);
                    }
                }
                if let Some(rest) = &e.rest {
                    self.visit_expr(rest);
                }
            }
            Expr::Cast(e) => self.visit_expr(&e.expr),
            Expr::Paren(e) => self.visit_expr(&e.expr),
            Expr::Group(e) => self.visit_expr(&e.expr),
            Expr::Reference(e) => self.visit_expr(&e.expr),
            Expr::RawAddr(e) => self.visit_expr(&e.expr),
            Expr::Unary(e) => self.visit_expr(&e.expr),
            Expr::Tuple(e) => {
                for elem in &e.elems {
                    self.visit_expr(elem);
                }
            }
            Expr::Array(e) => {
                for elem in &e.elems {
                    self.visit_expr(elem);
                }
            }
            Expr::Repeat(e) => {
                self.visit_expr(&e.expr);
                self.visit_expr(&e.len);
            }
            Expr::Range(e) => {
                if let Some(s) = &e.start {
                    self.visit_expr(s);
                }
                if let Some(end) = &e.end {
                    self.visit_expr(end);
                }
            }
            Expr::Return(e) => {
                if let Some(v) = &e.expr {
                    self.visit_expr(v);
                }
            }
            Expr::Break(e) => {
                if let Some(v) = &e.expr {
                    self.visit_expr(v);
                }
            }
            _ => {}
        }
    }

    fn visit_field_read(&mut self, ef: &ExprField) {
        let base = unwrap_paren(&ef.base);
        if is_self_expr(base) {
            let member = match &ef.member {
                Member::Named(id) => id.to_string(),
                Member::Unnamed(idx) => idx.index.to_string(),
            };
            let (line, col) = loc_of_node(ef);
            self.bucket.reads.push(ReadFact {
                name: format!("self.{member}"),
                scope: "member",
                decl: self.self_member_decl,
                from: None,
                line,
                col,
            });
            return;
        }
        self.visit_expr(&ef.base);
    }
}

fn empty_bucket(name: String, line: usize, col: usize, params: Vec<String>) -> FunctionBucket {
    FunctionBucket {
        name,
        line,
        col,
        params,
        reads: Vec::new(),
        writes: Vec::new(),
        calls: Vec::new(),
        subscripts: Vec::new(),
        throws: Vec::new(),
        catches: Vec::new(),
        loops: Vec::new(),
        suspends: Vec::new(),
    }
}

fn unwrap_paren(expr: &Expr) -> &Expr {
    let mut cur = expr;
    loop {
        match cur {
            Expr::Paren(p) => cur = &p.expr,
            Expr::Group(g) => cur = &g.expr,
            other => return other,
        }
    }
}

fn is_self_expr(expr: &Expr) -> bool {
    matches!(unwrap_paren(expr), Expr::Path(ep) if ep.qself.is_none() && ep.path.is_ident("self"))
}

fn unwrap_write_chain(expr: &Expr) -> (&Expr, Vec<String>) {
    let mut path = Vec::new();
    let mut cur = unwrap_paren(expr);
    loop {
        match cur {
            Expr::Field(f) => {
                let seg = match &f.member {
                    Member::Named(id) => id.to_string(),
                    Member::Unnamed(idx) => idx.index.to_string(),
                };
                path.push(seg);
                cur = unwrap_paren(&f.base);
            }
            Expr::Index(idx) => {
                path.push("(index)".to_string());
                cur = unwrap_paren(&idx.expr);
            }
            Expr::Unary(u) if matches!(u.op, syn::UnOp::Deref(_)) => {
                path.push("*".to_string());
                cur = unwrap_paren(&u.expr);
            }
            other => {
                path.reverse();
                return (other, path);
            }
        }
    }
}

fn is_compound_assign(op: BinOp) -> bool {
    matches!(
        op,
        BinOp::AddAssign(_)
            | BinOp::SubAssign(_)
            | BinOp::MulAssign(_)
            | BinOp::DivAssign(_)
            | BinOp::RemAssign(_)
            | BinOp::BitXorAssign(_)
            | BinOp::BitAndAssign(_)
            | BinOp::BitOrAssign(_)
            | BinOp::ShlAssign(_)
            | BinOp::ShrAssign(_)
    )
}

fn simple_pat_ident(pat: &Pat) -> Option<String> {
    match pat {
        Pat::Ident(pi) if pi.subpat.is_none() => Some(pi.ident.to_string()),
        Pat::Type(pt) => simple_pat_ident(&pt.pat),
        Pat::Paren(pp) => simple_pat_ident(&pp.pat),
        _ => None,
    }
}

fn param_text_from_pat(pat: &Pat, src: &SourceText) -> String {
    match pat {
        Pat::Ident(pi) if pi.subpat.is_none() => pi.ident.to_string(),
        Pat::Type(pt) => param_text_from_pat(&pt.pat, src),
        Pat::Paren(pp) => param_text_from_pat(&pp.pat, src),
        other => src.slice_tokens(other),
    }
}

fn collect_pat_bindings(pat: &Pat, out: &mut HashMap<String, Binding>) {
    match pat {
        Pat::Ident(pi) => {
            out.insert(pi.ident.to_string(), Binding::Param);
            if let Some((_, sub)) = &pi.subpat {
                collect_pat_bindings(sub, out);
            }
        }
        Pat::Tuple(pt) => {
            for elem in &pt.elems {
                collect_pat_bindings(elem, out);
            }
        }
        Pat::Slice(ps) => {
            for elem in &ps.elems {
                collect_pat_bindings(elem, out);
            }
        }
        Pat::Struct(ps) => {
            for field in &ps.fields {
                collect_pat_bindings(&field.pat, out);
            }
        }
        Pat::TupleStruct(pts) => {
            for elem in &pts.elems {
                collect_pat_bindings(elem, out);
            }
        }
        Pat::Or(po) => {
            for case in &po.cases {
                collect_pat_bindings(case, out);
            }
        }
        Pat::Reference(pr) => collect_pat_bindings(&pr.pat, out),
        Pat::Type(pt) => collect_pat_bindings(&pt.pat, out),
        Pat::Paren(pp) => collect_pat_bindings(&pp.pat, out),
        _ => {}
    }
}

struct WalkEnv<'a> {
    index: &'a ModuleIndex,
    src: &'a SourceText,
    mod_prefix: &'a [String],
}

struct WalkTarget {
    owner_type: Option<String>,
    fn_name: String,
    line: usize,
    col: usize,
}

fn walk_signature_and_block(
    env: &WalkEnv<'_>,
    target: WalkTarget,
    sig: &syn::Signature,
    block: &Block,
    inherited_scopes: Vec<HashMap<String, Binding>>,
    inherited_local_fns: Vec<HashMap<String, String>>,
) -> Vec<FunctionBucket> {
    let mut params = Vec::new();
    let mut param_frame = HashMap::new();
    let mut self_member_decl = "readonly";

    for arg in &sig.inputs {
        match arg {
            FnArg::Receiver(r) => {
                params.push("self".to_string());
                if r.mutability.is_some() {
                    self_member_decl = "mutable";
                }
            }
            FnArg::Typed(pt) => {
                params.push(param_text_from_pat(&pt.pat, env.src));
                collect_pat_bindings(&pt.pat, &mut param_frame);
            }
        }
    }

    let mut scopes = inherited_scopes;
    scopes.push(param_frame);
    let closure_vars = vec![HashMap::new(); scopes.len()];
    let mut local_fn_scopes = inherited_local_fns;
    local_fn_scopes.push(HashMap::new());

    let bucket = empty_bucket(target.fn_name.clone(), target.line, target.col, params);
    let mut ctx = FnContext {
        index: env.index,
        src: env.src,
        mod_prefix: env.mod_prefix,
        owner_type: target.owner_type,
        fn_name: target.fn_name,
        self_member_decl,
        scopes,
        local_fn_scopes,
        closure_vars,
        bucket,
        children: Vec::new(),
    };
    ctx.precollect_block(block);
    for stmt in &block.stmts {
        ctx.visit_stmt(stmt);
    }

    let mut result = Vec::with_capacity(1 + ctx.children.len());
    result.push(ctx.bucket);
    result.extend(ctx.children);
    result
}

fn walk_item_fn(
    index: &ModuleIndex,
    src: &SourceText,
    mod_prefix: &[String],
    owner_type: Option<String>,
    fn_name: String,
    f: &ItemFn,
) -> Vec<FunctionBucket> {
    let (line, col) = loc_of_node(f);
    let env = WalkEnv {
        index,
        src,
        mod_prefix,
    };
    walk_signature_and_block(
        &env,
        WalkTarget {
            owner_type,
            fn_name,
            line,
            col,
        },
        &f.sig,
        &f.block,
        Vec::new(),
        Vec::new(),
    )
}

fn walk_impl(
    index: &ModuleIndex,
    src: &SourceText,
    mod_prefix: &[String],
    imp: &ItemImpl,
    out: &mut Vec<FunctionBucket>,
) {
    let owner = qual_join(mod_prefix, &type_base_name(&imp.self_ty, src));
    let trait_name = imp.trait_.as_ref().map(|(_, p, _)| path_base_name(p));
    let env = WalkEnv {
        index,
        src,
        mod_prefix,
    };
    for item in &imp.items {
        if let ImplItem::Fn(m) = item {
            let mname = m.sig.ident.to_string();
            let full = match &trait_name {
                Some(tr) => format!("<{owner} as {tr}>::{mname}"),
                None => format!("{owner}::{mname}"),
            };
            let (line, col) = loc_of_node(m);
            out.extend(walk_signature_and_block(
                &env,
                WalkTarget {
                    owner_type: Some(owner.clone()),
                    fn_name: full,
                    line,
                    col,
                },
                &m.sig,
                &m.block,
                Vec::new(),
                Vec::new(),
            ));
        }
    }
}

fn walk_trait(
    index: &ModuleIndex,
    src: &SourceText,
    mod_prefix: &[String],
    tr: &ItemTrait,
    out: &mut Vec<FunctionBucket>,
) {
    let owner = qual_join(mod_prefix, &tr.ident.to_string());
    let env = WalkEnv {
        index,
        src,
        mod_prefix,
    };
    for item in &tr.items {
        if let TraitItem::Fn(m) = item
            && let Some(block) = &m.default
        {
            let full = format!("{owner}::{}", m.sig.ident);
            let (line, col) = loc_of_node(m);
            out.extend(walk_signature_and_block(
                &env,
                WalkTarget {
                    owner_type: Some(owner.clone()),
                    fn_name: full,
                    line,
                    col,
                },
                &m.sig,
                block,
                Vec::new(),
                Vec::new(),
            ));
        }
    }
}

fn walk_mod(
    index: &ModuleIndex,
    src: &SourceText,
    mod_prefix: &mut Vec<String>,
    m: &ItemMod,
    out: &mut Vec<FunctionBucket>,
) {
    if let Some((_, items)) = &m.content {
        mod_prefix.push(m.ident.to_string());
        walk_items(index, src, mod_prefix, items, out);
        mod_prefix.pop();
    }
}

fn walk_items(
    index: &ModuleIndex,
    src: &SourceText,
    mod_prefix: &mut Vec<String>,
    items: &[Item],
    out: &mut Vec<FunctionBucket>,
) {
    for item in items {
        match item {
            Item::Fn(f) => {
                let name = qual_join(mod_prefix, &f.sig.ident.to_string());
                out.extend(walk_item_fn(index, src, mod_prefix, None, name, f));
            }
            Item::Impl(imp) => walk_impl(index, src, mod_prefix, imp, out),
            Item::Trait(tr) => walk_trait(index, src, mod_prefix, tr, out),
            Item::Mod(m) => walk_mod(index, src, mod_prefix, m, out),
            _ => {}
        }
    }
}

fn observe(path: PathBuf) -> Result<RayOutput, String> {
    let canon = fs::canonicalize(&path).unwrap_or(path);
    let file_str = canon.to_string_lossy().replace('\\', "/");
    let raw = fs::read_to_string(&canon).map_err(|e| format!("failed to read {file_str}: {e}"))?;
    let parsed = syn::parse_file(&raw).map_err(|e| format!("failed to parse {file_str}: {e}"))?;
    let src = SourceText::new(raw);

    let mut index = ModuleIndex::new();
    let mut mod_prefix = Vec::new();
    index.collect_items(&parsed.items, &mut mod_prefix, &src);

    let mut functions = Vec::new();
    walk_items(&index, &src, &mut mod_prefix, &parsed.items, &mut functions);

    Ok(RayOutput {
        file: file_str,
        language: "rust",
        functions,
    })
}

fn main() {
    let Some(arg) = env::args_os().nth(1) else {
        eprintln!("usage: lambda-ray-observe <file.rs>");
        process::exit(2);
    };
    match observe(PathBuf::from(arg)) {
        Ok(out) => match serde_json::to_string(&out) {
            Ok(json) => println!("{json}"),
            Err(e) => {
                eprintln!("lambda-ray-observe: {e}");
                process::exit(1);
            }
        },
        Err(e) => {
            eprintln!("lambda-ray-observe: {e}");
            process::exit(1);
        }
    }
}
