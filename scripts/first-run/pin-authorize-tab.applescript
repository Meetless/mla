(*
Keep exactly ONE /cli/authorize tab alive in the operator's real browser.

Used by capture-identity.sh. The login window is 5 minutes; a human is not.
This repoints the EXISTING authorize tab at a freshly minted URL instead of
stacking a new tab per attempt, and closes any stale authorize tabs so nobody
can click a dead one. That matters: a stale tab still POSTs, still mints a real
grant, and still 303s to a loopback listener that is gone, so the grant is
burned and the click merely looks broken.

Only tabs under the authorize path are ever read or touched.

Usage: osascript pin-authorize-tab.applescript <url> [activate]
*)
on run argv
	set target to item 1 of argv
	set doActivate to ((count of argv) > 1)
	set prefix to "https://app.meetless.ai/cli/authorize"

	tell application "Google Chrome"
		if (count of windows) is 0 then
			make new window
		end if

		set stale to {}
		set pinned to missing value
		repeat with w in windows
			repeat with t in tabs of w
				if (URL of t as string) starts with prefix then
					if pinned is missing value then
						set pinned to t
					else
						set end of stale to t
					end if
				end if
			end repeat
		end repeat

		if pinned is missing value then
			tell front window
				set pinned to make new tab with properties {URL:target}
			end tell
		else
			set URL of pinned to target
			repeat with t in stale
				close t
			end repeat
		end if

		if doActivate then activate
	end tell
	return "ok"
end run
