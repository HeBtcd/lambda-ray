#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace Dog.Sim
{
    public interface ISim<TState, TCommand>
    {
        int StepsPerSecond { get; }
        TState Init { get; }
        TState Step(TState state, IReadOnlyList<TCommand> commands);
    }

    public interface ILayer<TMemory, TInput, TOutput>
    {
        TMemory Init { get; }
        TMemory Step(TMemory memory, TInput input);
        TOutput Out(TMemory memory);
    }

    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Struct, Inherited = false)]
    public sealed class SimShellAttribute : Attribute
    {
    }

    public sealed class Log<T> : IReadOnlyList<IReadOnlyList<T>>
    {
        public static readonly Log<T> Empty = new Log<T>(null, new ReadOnlyCollection<T>(Array.Empty<T>()), 0);

        private readonly Log<T>? previous;
        private readonly IReadOnlyList<T> last;

        private Log(Log<T>? previous, IReadOnlyList<T> last, int count)
        {
            this.previous = previous;
            this.last = last;
            Count = count;
        }

        public int Count { get; }

        public IReadOnlyList<T> this[int tick]
        {
            get
            {
                if (tick < 0 || tick >= Count) throw new ArgumentOutOfRangeException(nameof(tick));
                return Prefix(tick + 1).last;
            }
        }

        public Log<T> Append(IReadOnlyList<T> commands)
        {
            if (commands == null) throw new ArgumentNullException(nameof(commands));
            var copy = new T[commands.Count];
            for (var i = 0; i < copy.Length; i++) copy[i] = commands[i];
            return new Log<T>(this, new ReadOnlyCollection<T>(copy), Count + 1);
        }

        public Log<T> Prefix(int tick)
        {
            if (tick < 0 || tick > Count) throw new ArgumentOutOfRangeException(nameof(tick));
            var log = this;
            while (log.Count > tick) log = log.previous!;
            return log;
        }

        public IEnumerator<IReadOnlyList<T>> GetEnumerator()
        {
            var ticks = new IReadOnlyList<T>[Count];
            for (var log = this; log.Count > 0; log = log.previous!) ticks[log.Count - 1] = log.last;
            return ((IEnumerable<IReadOnlyList<T>>)ticks).GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    public readonly struct Sync<TState>
    {
        public Sync(bool ok, int firstDivergentTick, TState direct)
        {
            Ok = ok;
            FirstDivergentTick = firstDivergentTick;
            Direct = direct;
        }

        public bool Ok { get; }
        public int FirstDivergentTick { get; }
        public TState Direct { get; }
    }

    [SimShell]
    public static class Run
    {
        public static TState Seek<TState, TCommand>(ISim<TState, TCommand> sim, Log<TCommand> log, int tick)
        {
            if (tick < 0 || tick > log.Count) throw new ArgumentOutOfRangeException(nameof(tick));
            var state = sim.Init;
            var at = 0;
            foreach (var commands in log)
            {
                if (at++ == tick) break;
                state = sim.Step(state, commands);
            }
            return state;
        }

        public static Sync<TState> Synctest<TState, TCommand>(ISim<TState, TCommand> sim, Log<TCommand> log)
        {
            var first = Trace(sim, log);
            var second = Trace(sim, log);
            var half = log.Count / 2;
            var resumed = Seek(sim, log, half);
            var tick = 0;
            foreach (var commands in log)
            {
                if (tick >= half) resumed = sim.Step(resumed, commands);
                tick++;
                if (!Same(first[tick], second[tick])) return new Sync<TState>(false, tick, first[log.Count]);
                if (tick > half && !Same(first[tick], resumed)) return new Sync<TState>(false, tick, first[log.Count]);
            }
            if (!Same(first[0], second[0])) return new Sync<TState>(false, 0, first[log.Count]);
            return new Sync<TState>(true, -1, first[log.Count]);
        }

        public static TOutput View<TMemory, TInput, TOutput>(ILayer<TMemory, TInput, TOutput> layer, IReadOnlyList<TInput> inputs, int tick, int window)
        {
            if (tick < 0 || tick > inputs.Count) throw new ArgumentOutOfRangeException(nameof(tick));
            var memory = layer.Init;
            for (var at = Math.Max(0, tick - window); at < tick; at++) memory = layer.Step(memory, inputs[at]);
            return layer.Out(memory);
        }

        public static bool Same(object? a, object? b) => Same(a, b, 0);

        private static TState[] Trace<TState, TCommand>(ISim<TState, TCommand> sim, Log<TCommand> log)
        {
            var states = new TState[log.Count + 1];
            states[0] = sim.Init;
            var tick = 0;
            foreach (var commands in log)
            {
                states[tick + 1] = sim.Step(states[tick], commands);
                tick++;
            }
            return states;
        }

        private static bool Same(object? a, object? b, int depth)
        {
            if (ReferenceEquals(a, b)) return true;
            if (a is null || b is null) return false;
            var type = a.GetType();
            if (type != b.GetType()) return false;
            if (depth > 64) throw new InvalidOperationException("state is deeper than 64 levels or cyclic");
            if (type.IsPrimitive || type.IsEnum || a is string || a is decimal) return a.Equals(b);
            if (a is IEnumerable left && b is IEnumerable right)
            {
                var l = left.GetEnumerator();
                var r = right.GetEnumerator();
                while (true)
                {
                    var hasLeft = l.MoveNext();
                    if (hasLeft != r.MoveNext()) return false;
                    if (!hasLeft) return true;
                    if (!Same(l.Current, r.Current, depth + 1)) return false;
                }
            }
            for (var t = type; t != null && t != typeof(object) && t != typeof(ValueType); t = t.BaseType)
            {
                foreach (var field in t.GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.DeclaredOnly))
                {
                    if (!Same(field.GetValue(a), field.GetValue(b), depth + 1)) return false;
                }
            }
            return true;
        }
    }
}

namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit
    {
    }
}
