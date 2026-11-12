using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace Dog.Laws
{
    internal abstract class Json
    {
        public sealed class Obj : Json
        {
            public readonly Dictionary<string, Json> Map = new Dictionary<string, Json>();
            public Json? this[string key] => Map.TryGetValue(key, out var value) ? value : null;
        }

        public sealed class Arr : Json
        {
            public readonly List<Json> Items = new List<Json>();
        }

        public sealed class Str : Json
        {
            public readonly string Value;
            public Str(string value) { Value = value; }
        }

        public sealed class Bool : Json
        {
            public readonly bool Value;
            public Bool(bool value) { Value = value; }
        }

        public sealed class Num : Json
        {
            public readonly double Value;
            public Num(double value) { Value = value; }
        }

        public static Json? Parse(string text)
        {
            var at = 0;
            var value = Read(text, ref at);
            return value;
        }

        private static void Skip(string text, ref int at)
        {
            while (at < text.Length && char.IsWhiteSpace(text[at])) at++;
        }

        private static Json? Read(string text, ref int at)
        {
            Skip(text, ref at);
            if (at >= text.Length) return null;
            switch (text[at])
            {
                case '{':
                    at++;
                    var obj = new Obj();
                    Skip(text, ref at);
                    if (at < text.Length && text[at] == '}') { at++; return obj; }
                    while (true)
                    {
                        var key = Read(text, ref at) as Str;
                        Skip(text, ref at);
                        if (key == null || at >= text.Length || text[at] != ':') return null;
                        at++;
                        var value = Read(text, ref at);
                        if (value == null) return null;
                        obj.Map[key.Value] = value;
                        Skip(text, ref at);
                        if (at >= text.Length) return null;
                        if (text[at] == ',') { at++; continue; }
                        if (text[at] == '}') { at++; return obj; }
                        return null;
                    }
                case '[':
                    at++;
                    var arr = new Arr();
                    Skip(text, ref at);
                    if (at < text.Length && text[at] == ']') { at++; return arr; }
                    while (true)
                    {
                        var value = Read(text, ref at);
                        if (value == null) return null;
                        arr.Items.Add(value);
                        Skip(text, ref at);
                        if (at >= text.Length) return null;
                        if (text[at] == ',') { at++; continue; }
                        if (text[at] == ']') { at++; return arr; }
                        return null;
                    }
                case '"':
                    return new Str(String(text, ref at));
                case 't':
                    if (text.Substring(at).StartsWith("true")) { at += 4; return new Bool(true); }
                    return null;
                case 'f':
                    if (text.Substring(at).StartsWith("false")) { at += 5; return new Bool(false); }
                    return null;
                case 'n':
                    if (text.Substring(at).StartsWith("null")) { at += 4; return new Obj(); }
                    return null;
                default:
                    var start = at;
                    while (at < text.Length && (char.IsDigit(text[at]) || text[at] == '-' || text[at] == '+' || text[at] == '.' || text[at] == 'e' || text[at] == 'E')) at++;
                    if (double.TryParse(text.Substring(start, at - start), NumberStyles.Float, CultureInfo.InvariantCulture, out var number)) return new Num(number);
                    return null;
            }
        }

        private static string String(string text, ref int at)
        {
            var sb = new StringBuilder();
            at++;
            while (at < text.Length)
            {
                var c = text[at++];
                if (c == '"') break;
                if (c == '\\' && at < text.Length)
                {
                    var e = text[at++];
                    switch (e)
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case 'u': sb.Append((char)int.Parse(text.Substring(at, 4), NumberStyles.HexNumber)); at += 4; break;
                        default: sb.Append(e); break;
                    }
                }
                else sb.Append(c);
            }
            return sb.ToString();
        }

        public static string? Text(Json? node) => (node as Str)?.Value;
        public static bool? Flag(Json? node) => (node as Bool)?.Value;
        public static int? Int(Json? node) => (node as Num) is Num n ? (int)n.Value : (int?)null;
        public static Obj? Object(Json? node) => node as Obj;
        public static Arr? Array(Json? node) => node as Arr;
    }
}
