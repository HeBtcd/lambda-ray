#nullable enable
using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;

namespace Dog.Sim
{
    [SimShell]
    public abstract class SimShell<TState, TCommand> : MonoBehaviour
    {
        private readonly List<TCommand> pending = new List<TCommand>();
        private ISim<TState, TCommand> sim = null!;
        private int holds;

        public Log<TCommand> Log { get; private set; } = Log<TCommand>.Empty;
        public TState State { get; private set; } = default!;
        public int Tick => Log.Count;
        public bool Viewing => holds > 0;

        protected abstract ISim<TState, TCommand> Create();
        protected virtual void Read(List<TCommand> commands) { }
        protected abstract void Project(TState state);

        public void Send(TCommand command) => pending.Add(command);

        public TState Seek(int tick) => Run.Seek(sim, Log, tick);

        public void Rewind(int tick)
        {
            Log = Log.Prefix(tick);
            State = Run.Seek(sim, Log, tick);
            Project(State);
        }

        public IEnumerator View(int tick, int warm)
        {
            if (tick < 0 || tick > Log.Count) throw new ArgumentOutOfRangeException(nameof(tick));
            if (warm < 0) throw new ArgumentOutOfRangeException(nameof(warm));
            holds++;
            try
            {
                var log = Log.Prefix(tick);
                var from = Math.Max(0, tick - warm);
                var state = Run.Seek(sim, log, from);
                var commands = new IReadOnlyList<TCommand>[tick - from];
                var at = 0;
                foreach (var batch in log)
                {
                    if (at >= from) commands[at - from] = batch;
                    at++;
                }
                Frames.Cut(from);
                Project(state);
                for (var i = 0; i < commands.Length; i++)
                {
                    yield return null;
                    state = sim.Step(state, commands[i]);
                    Project(state);
                }
                Log = log;
                State = state;
            }
            finally
            {
                holds--;
            }
        }

        protected virtual void Awake()
        {
            sim = Create();
            Time.fixedDeltaTime = 1f / sim.StepsPerSecond;
            State = sim.Init;
            Project(State);
        }

        protected virtual void Update()
        {
            if (holds == 0) Read(pending);
        }

        protected virtual void FixedUpdate()
        {
            if (holds > 0) return;
            var commands = pending.ToArray();
            pending.Clear();
            Log = Log.Append(commands);
            State = sim.Step(State, commands);
            Project(State);
        }
    }

    [SimShell]
    public static class Frames
    {
        public static int Cut(int tick)
        {
            var aligned = 0;
            foreach (var camera in UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (Cut(camera, tick)) aligned++;
            }
            return aligned;
        }

        public static bool Cut(Camera camera, int tick)
        {
            var aligned = false;
            foreach (var component in camera.GetComponents<Component>())
            {
                if (component == null) continue;
                var type = component.GetType();
                var reset = type.GetProperty("resetHistory", typeof(bool));
                if (reset == null || !reset.CanWrite) continue;
                reset.SetValue(component, true);
                var settings = type.GetField("m_TaaSettings", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                var offset = settings?.FieldType.GetField("jitterFrameCountOffset", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
                if (settings == null || offset == null || offset.FieldType != typeof(int)) continue;
                var boxed = settings.GetValue(component);
                offset.SetValue(boxed, (int)offset.GetValue(boxed) + tick);
                settings.SetValue(component, boxed);
                aligned = true;
            }
            return aligned;
        }

        public static RenderTexture Target(Camera camera, int width, int height)
        {
            var target = camera.targetTexture;
            if (target != null && target.width == width && target.height == height) return target;
            target = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32) { name = "Dog.Frames" };
            target.Create();
            camera.targetTexture = target;
            return target;
        }

        public static Texture2D Render(Camera camera, int width, int height)
        {
            var target = Target(camera, width, height);
            camera.Render();
            return Read(target);
        }

        public static Texture2D Read(RenderTexture target)
        {
            var active = RenderTexture.active;
            RenderTexture.active = target;
            var image = new Texture2D(target.width, target.height, TextureFormat.RGBA32, false);
            image.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
            image.Apply();
            RenderTexture.active = active;
            return image;
        }

        public static float Differs(Texture2D a, Texture2D b, int threshold = 8)
        {
            if (a.width != b.width || a.height != b.height) throw new ArgumentException("frames differ in size");
            var x = a.GetPixels32();
            var y = b.GetPixels32();
            var off = 0;
            for (var i = 0; i < x.Length; i++)
            {
                if (Math.Abs(x[i].r - y[i].r) > threshold || Math.Abs(x[i].g - y[i].g) > threshold || Math.Abs(x[i].b - y[i].b) > threshold) off++;
            }
            return (float)off / x.Length;
        }
    }
}
