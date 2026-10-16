Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
currentDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
vbsPath = currentDir & "\TubeGrab.vbs"
icoPath = currentDir & "\icon.ico"

' 1. Desktop shortcut
desktopPath = WshShell.SpecialFolders("Desktop")
Set shortcut = WshShell.CreateShortcut(desktopPath & "\TubeGrab.lnk")
shortcut.TargetPath = vbsPath
shortcut.WorkingDirectory = currentDir
shortcut.IconLocation = icoPath & ",0"
shortcut.Description = "TubeGrab - YouTube Video & Audio Downloader"
shortcut.Save

' 2. Start Menu shortcut
startMenuPath = WshShell.SpecialFolders("Programs")
Set shortcut2 = WshShell.CreateShortcut(startMenuPath & "\TubeGrab.lnk")
shortcut2.TargetPath = vbsPath
shortcut2.WorkingDirectory = currentDir
shortcut2.IconLocation = icoPath & ",0"
shortcut2.Description = "TubeGrab - YouTube Video & Audio Downloader"
shortcut2.Save

WScript.Echo "TubeGrab desktop and Start Menu shortcuts successfully created!"
