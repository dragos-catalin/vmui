' Launch a console program with NO window at all. Task Scheduler's "Hidden"
' flag only hides the task from the UI; a console exe still flashes a window
' for a few hundred ms under an interactive token. WScript.Shell.Run with
' window style 0 does not. Used by vmui-service and vmui-publish-* tasks.
'
'   wscript.exe hidden-run.vbs <exe> [args...]
'
Option Explicit
Dim sh, i, cmd, start, rc
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count = 0 Then WScript.Quit 2
' "--wait" as the FIRST argument: wait for the child and return ITS exit code, so Task Scheduler's
' LastTaskResult shows a real failure. Without it this launcher exits 0 immediately and a job that has
' been failing for hours still looks green (2026-11-22: the agentq -> hub mirror returned HTTP 400 for
' 6.5 h while the task result stayed 0). Opt-in per task: a task that starts a long-lived service must
' not be waited on, or IgnoreNew would skip every later tick while it runs.
start = 0
If WScript.Arguments(0) = "--wait" Then start = 1
If start = 1 And WScript.Arguments.Count < 2 Then WScript.Quit 2
cmd = ""
For i = start To WScript.Arguments.Count - 1
    If InStr(WScript.Arguments(i), " ") > 0 Then
        cmd = cmd & """" & WScript.Arguments(i) & """ "
    Else
        cmd = cmd & WScript.Arguments(i) & " "
    End If
Next
' 0 = hidden window. False = do not wait (the launcher decides its own lifetime)
If start = 1 Then
    rc = sh.Run(cmd, 0, True)
    WScript.Quit rc
Else
    sh.Run cmd, 0, False
End If
