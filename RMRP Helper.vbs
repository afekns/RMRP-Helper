' RMRP Helper — тихий запуск без окна консоли
Option Explicit

Dim shell, fso, scriptDir, nodeExe, launcher, cmd

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = scriptDir

If Not HasNode() Then
  MsgBox "Node.js не найден." & vbCrLf & vbCrLf & "Установите Node.js с https://nodejs.org и повторите.", vbCritical, "RMRP Helper"
  WScript.Quit 1
End If
nodeExe = "node"

launcher = scriptDir & "\scripts\launcher.mjs"
If Not fso.FileExists(launcher) Then
  MsgBox "Файл запускатора не найден:" & vbCrLf & launcher, vbCritical, "RMRP Helper"
  WScript.Quit 1
End If

cmd = "cmd /c """ & nodeExe & """ """ & launcher & """ --silent"
shell.Run cmd, 0, False

Function HasNode()
  Dim exec
  On Error Resume Next
  Set exec = shell.Exec("node --version")
  If Err.Number <> 0 Then
    HasNode = False
    Exit Function
  End If
  Do While exec.Status = 0
    WScript.Sleep 40
  Loop
  HasNode = (exec.ExitCode = 0)
End Function