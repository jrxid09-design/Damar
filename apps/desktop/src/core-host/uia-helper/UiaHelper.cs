// UiaHelper - bench-phase UI Automation bridge for the Damar computer-use
// substrate. One-shot CLI: reads a JSON request on stdin, answers one JSON
// line on stdout. Modes:
//   {"mode":"tree","hwnd":123,"maxDepth":6,"maxNodes":300}
//     -> {"ok":true,"tree":{...}} element tree of the window: control type,
//        name, bounding rect, value (ValuePattern), toggle state, and the
//        actionable patterns exposed (Invoke/Value/Toggle/SelectionItem).
//   {"mode":"invoke","hwnd":123,"name":"OK","type":"Button"}
//     -> invokes the first matching element (InvokePattern, fallback
//        Toggle/SelectionItem, fallback legacy click via rect center is NOT
//        done here - pixel input stays with SendInput in the broker).
//   {"mode":"setvalue","hwnd":123,"name":"...","type":"Edit","value":"25"}
//     -> ValuePattern.SetValue on the first matching element.
// Element identity is (name, control type) within one window - good enough
// for dialogs and panels; ambiguous matches report a count.
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;

class UiaHelper
{
    static JavaScriptSerializer Json = new JavaScriptSerializer();

    static Dictionary<string, object> ElemInfo(AutomationElement el)
    {
        var d = new Dictionary<string, object>();
        try { d["type"] = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""); }
        catch { d["type"] = "?"; }
        try { d["name"] = el.Current.Name ?? ""; } catch { d["name"] = ""; }
        try
        {
            var r = el.Current.BoundingRectangle;
            d["rect"] = new int[] { (int)r.Left, (int)r.Top, (int)r.Width, (int)r.Height };
        }
        catch { d["rect"] = new int[] { 0, 0, 0, 0 }; }
        var pats = new List<string>();
        object p;
        if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
        {
            pats.Add("Value");
            try { d["value"] = ((ValuePattern)p).Current.Value ?? ""; } catch { }
            try { d["valueRO"] = ((ValuePattern)p).Current.IsReadOnly; } catch { }
        }
        if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) pats.Add("Invoke");
        if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p))
        {
            pats.Add("Toggle");
            try { d["toggle"] = ((TogglePattern)p).Current.ToggleState.ToString(); } catch { }
        }
        if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
        {
            pats.Add("SelectionItem");
            try { d["selected"] = ((SelectionItemPattern)p).Current.IsSelected; } catch { }
        }
        if (el.TryGetCurrentPattern(TextPattern.Pattern, out p)) pats.Add("Text");
        d["patterns"] = pats.ToArray();
        try { d["enabled"] = el.Current.IsEnabled; } catch { }
        try { d["offscreen"] = el.Current.IsOffscreen; } catch { }
        return d;
    }

    static Dictionary<string, object> Walk(AutomationElement el, int depth, int maxDepth, int[] budget)
    {
        var d = ElemInfo(el);
        budget[0]--;
        if (depth < maxDepth && budget[0] > 0)
        {
            var kids = new List<object>();
            try
            {
                var child = TreeWalker.RawViewWalker.GetFirstChild(el);
                while (child != null && budget[0] > 0)
                {
                    kids.Add(Walk(child, depth + 1, maxDepth, budget));
                    child = TreeWalker.RawViewWalker.GetNextSibling(child);
                }
            }
            catch { }
            if (kids.Count > 0) d["children"] = kids.ToArray();
        }
        return d;
    }

    static AutomationElement FindFirst(AutomationElement root, string name, string type)
    {
        var conds = new List<Condition>();
        if (!string.IsNullOrEmpty(name)) conds.Add(new PropertyCondition(AutomationElement.NameProperty, name));
        if (!string.IsNullOrEmpty(type))
        {
            foreach (var ct in new[] { ControlType.Button, ControlType.Edit, ControlType.MenuItem, ControlType.CheckBox,
                                       ControlType.RadioButton, ControlType.ComboBox, ControlType.ListItem, ControlType.TabItem,
                                       ControlType.Text, ControlType.Document, ControlType.Pane, ControlType.Window, ControlType.Slider,
                                       ControlType.Spinner, ControlType.Hyperlink, ControlType.TreeItem, ControlType.DataItem,
                                       ControlType.Header, ControlType.ToolBar, ControlType.Menu, ControlType.MenuBar, ControlType.StatusBar })
                if (ct.ProgrammaticName == "ControlType." + type) { conds.Add(new PropertyCondition(AutomationElement.ControlTypeProperty, ct)); break; }
        }
        if (conds.Count == 0) return null;
        Condition cond = conds.Count == 1 ? conds[0] : new AndCondition(conds.ToArray());
        try { return root.FindFirst(TreeScope.Descendants, cond); } catch { return null; }
    }

    static int CountMatches(AutomationElement root, string name, string type)
    {
        var tmp = FindFirst(root, name, type);
        if (tmp == null) return 0;
        // cheap ambiguity probe: find all with the same condition, capped
        try
        {
            var conds = new List<Condition>();
            if (!string.IsNullOrEmpty(name)) conds.Add(new PropertyCondition(AutomationElement.NameProperty, name));
            Condition cond = conds.Count == 1 ? conds[0] : Condition.TrueCondition;
            var all = root.FindAll(TreeScope.Descendants, cond);
            return Math.Min(all.Count, 999);
        }
        catch { return 1; }
    }

    static void Main()
    {
        try
        {
            string input = new StreamReader(Console.OpenStandardInput()).ReadToEnd();
            var req = Json.Deserialize<Dictionary<string, object>>(input);
            string mode = req.ContainsKey("mode") ? (string)req["mode"] : "tree";
            long hwndVal = req.ContainsKey("hwnd") ? Convert.ToInt64(req["hwnd"]) : 0;
            var root = AutomationElement.FromHandle(new IntPtr(hwndVal));
            if (root == null) { Out(new Dictionary<string, object> { { "ok", false }, { "error", "WINDOW_NOT_FOUND" } }); return; }

            if (mode == "tree")
            {
                int maxDepth = req.ContainsKey("maxDepth") ? Convert.ToInt32(req["maxDepth"]) : 6;
                int maxNodes = req.ContainsKey("maxNodes") ? Convert.ToInt32(req["maxNodes"]) : 300;
                var budget = new int[] { maxNodes };
                var tree = Walk(root, 0, maxDepth, budget);
                Out(new Dictionary<string, object> { { "ok", true }, { "tree", tree }, { "truncated", budget[0] <= 0 } });
            }
            else if (mode == "invoke" || mode == "setvalue")
            {
                string name = req.ContainsKey("name") ? (string)req["name"] : "";
                string type = req.ContainsKey("type") ? (string)req["type"] : "";
                var el = FindFirst(root, name, type);
                if (el == null) { Out(new Dictionary<string, object> { { "ok", false }, { "error", "ELEMENT_NOT_FOUND" } }); return; }
                int matches = CountMatches(root, name, type);
                object p;
                if (mode == "invoke")
                {
                    if (el.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); }
                    else if (el.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); }
                    else if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); }
                    else { Out(new Dictionary<string, object> { { "ok", false }, { "error", "NO_ACTIONABLE_PATTERN" }, { "matches", matches } }); return; }
                    Out(new Dictionary<string, object> { { "ok", true }, { "matches", matches }, { "element", ElemInfo(el) } });
                }
                else
                {
                    string value = req.ContainsKey("value") ? (string)req["value"] : "";
                    if (!el.TryGetCurrentPattern(ValuePattern.Pattern, out p)) { Out(new Dictionary<string, object> { { "ok", false }, { "error", "NO_VALUE_PATTERN" }, { "matches", matches } }); return; }
                    ((ValuePattern)p).SetValue(value);
                    Out(new Dictionary<string, object> { { "ok", true }, { "matches", matches }, { "element", ElemInfo(el) } });
                }
            }
            else Out(new Dictionary<string, object> { { "ok", false }, { "error", "MODE_UNKNOWN" } });
        }
        catch (Exception e)
        {
            Out(new Dictionary<string, object> { { "ok", false }, { "error", e.GetType().Name + ":" + e.Message.Substring(0, Math.Min(120, e.Message.Length)) } });
        }
    }

    static void Out(Dictionary<string, object> d)
    {
        Console.Out.WriteLine(Json.Serialize(d));
    }
}
