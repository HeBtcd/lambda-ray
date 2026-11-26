---
name: lambda-ray
description: "Functional design: model the domain in types, keep state essential, parse at the boundary, push side effects to the edges, keep design matrices lower-triangular, refactor by substitution, write laws as properties, and convict idioms that hurt by design. Use when modeling a domain, untangling state and branching, deciding where side effects live, checking coupling/DAG boundaries, refactoring toward correctness, or judging whether an FP idiom earns its ceremony."
---

# Functional Programming

Eight moments, in the order the work meets them.

1. **Model** ([Wlaschin](https://fsharpforfunandprofit.com/posts/designing-with-types-making-illegal-states-unrepresentable/)): list valid domain states and represent them with union types so illegal states are unrepresentable.
   > Once it is put like this, the solution becomes obvious – use a union type with a case for each possibility.
2. **Untangle** (Moseley & Marks, [Out of the Tar Pit](https://curtclifton.net/papers/MoseleyMarks06a.pdf) 2006): keep only user-supplied essential state; recompute derived data instead of storing it.
   > Data of this kind can always be re-derived (from the input data — i.e. from the essential state) whenever required. [...] it is clearly accidental state.
3. **Parse** (King, [Parse, don't validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/); [LangSec](http://langsec.org/papers/langsec-cwes-secdev2016.pdf)): replace scattered shotgun checks with boundary parsers returning refined types.
   > Push the burden of proof upward as far as possible, but no further. Get your data into the most precise representation you need as quickly as you can.
4. **Isolate** (Bernhardt, [Boundaries](https://www.destroyallsoftware.com/talks/boundaries); Seemann, [Ports and Adapters](https://web.archive.org/web/2024/https://blog.ploeh.dk/2016/03/18/functional-architecture-is-ports-and-adapters/)): push `IO` and side effects to a thin imperative shell; keep decisions in a pure core.
   > [...] the functional core is heavy on paths heavy on decisions light on dependencies which is exactly what unit testing is good at [...]
5. **Decouple** (Nam Pyo Suh, *The Principles of Design*, MIT 1990; [Axiomatic design](https://en.wikipedia.org/wiki/Axiomatic_design)): map FRs to DPs (`{FR} = [A]{DP}`) as a diagonal or lower-triangular DAG. Never lump/split FRs to fake a diagonal, never hide an `X` behind pass-through wrappers, and isolate coupled invariants inside a minimal Essential Core whose outward boundary stays strictly lower-triangular.
   > Axiom 1: Maintain the independence of the functional requirements (FRs).
   > Axiom 2: Minimize the information content of the design.
6. **Substitute** (Strachey, [Fundamental Concepts](https://www.cs.cmu.edu/~crary/819-f09/Strachey67.pdf) 1967; [FP in Scala](https://livebook.manning.com/book/functional-programming-in-scala/chapter-1)): preserve referential transparency; replace hidden state (`time`, `rng`, `env`, files) with explicit arguments.
   > [...] if we wish to find the value of an expression which contains a sub-expression, the only thing we need to know about the sub-expression is its value.
7. **Specify** (Claessen & Hughes, [QuickCheck](https://www.cs.tufts.edu/~nr/cs257/archive/john-hughes/quick.pdf) 2000): state module laws as executable properties beside the code and hunt counterexamples.
   > Properties are normally written in the same module as the functions they test, where they serve also as checkable documentation of the behaviour of the code.
8. **Convict** ([foldl'](https://github.com/haskell/core-libraries-committee/issues/167), [Isar](https://isabelle.in.tum.de/website-Isabelle2024/dist/library/Doc/Prog_Prove/Isar.html), [Scala 3 implicits](https://docs.scala-lang.org/scala3/book/ca-contextual-abstractions-intro.html)): judge an idiom by normal design cost, convict only the smallest harmful variant, and strip ceremony that breaks clarity.
