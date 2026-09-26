#!/bin/sh

session_id=$1
[ -n "$session_id" ] || exit 1

exec /usr/bin/osascript - "$session_id" <<'APPLESCRIPT'
on run argv
  set targetSessionId to item 1 of argv

  tell application id "com.googlecode.iterm2"
    activate

    repeat with aWindow in windows
      repeat with aTab in tabs of aWindow
        repeat with aSession in sessions of aTab
          if (id of aSession as text) is targetSessionId then
            select aSession
            select aTab
            select aWindow
            return
          end if
        end repeat
      end repeat
    end repeat
  end tell
end run
APPLESCRIPT
