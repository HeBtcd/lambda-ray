using System.Collections.Immutable;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.Diagnostics;

namespace Dog.Laws
{
    [DiagnosticAnalyzer(LanguageNames.CSharp)]
    public sealed class SimLawsAnalyzer : DiagnosticAnalyzer
    {
        public static readonly DiagnosticDescriptor StateIsData = Rule("DOG001", "state-is-data");
        public static readonly DiagnosticDescriptor CommandsAreData = Rule("DOG002", "commands-are-data");
        public static readonly DiagnosticDescriptor StepIsPure = Rule("DOG003", "step-is-pure");
        public static readonly DiagnosticDescriptor LogIsAppendOnly = Rule("DOG004", "log-is-append-only");
        public static readonly DiagnosticDescriptor ProjectNeverWritesBack = Rule("DOG005", "project-never-writes-back");
        public static readonly DiagnosticDescriptor ProjectIsAFunctionOfState = Rule("DOG006", "project-is-a-function-of-state");

        private static DiagnosticDescriptor Rule(string id, string title) =>
            new DiagnosticDescriptor(id, title, "{0}", "Dog.Laws", DiagnosticSeverity.Error, isEnabledByDefault: true);

        public override ImmutableArray<DiagnosticDescriptor> SupportedDiagnostics { get; } =
            ImmutableArray.Create(StateIsData, CommandsAreData, StepIsPure, LogIsAppendOnly, ProjectNeverWritesBack, ProjectIsAFunctionOfState);

        public override void Initialize(AnalysisContext context)
        {
            context.ConfigureGeneratedCodeAnalysis(GeneratedCodeAnalysisFlags.None);
            context.EnableConcurrentExecution();
            context.RegisterCompilationStartAction(start =>
            {
                var laws = Laws.For(start.Compilation);
                if (laws == null) return;
                start.RegisterSymbolAction(laws.CheckType, SymbolKind.NamedType);
                start.RegisterOperationAction(laws.CheckWriteBack,
                    OperationKind.Invocation, OperationKind.SimpleAssignment, OperationKind.CompoundAssignment,
                    OperationKind.CoalesceAssignment, OperationKind.Increment, OperationKind.Decrement,
                    OperationKind.DeconstructionAssignment);
            });
        }
    }
}
