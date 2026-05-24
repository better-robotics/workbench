# Pi systemd patterns

## Unit preconditions belong in the script, not in `Condition*`

`ConditionPathExists=`, `ConditionFileNotEmpty=`, etc. evaluate **once** at
unit-start time and silently skip the unit when false — no retry, no log
noise the operator can search for, no recovery without manual `systemctl
start`. When the prerequisite is racy (asynchronous kernel-driver probes,
hotplug events, network reachability, anything not synchronously guaranteed
by an `After=` ordering), a missed check turns the unit invisibly inert
until the next reboot, and even that may race the same way.

Pattern instead: drop the `Condition*` and wait inside the `ExecStart`
script with a bounded poll loop. The script makes the timeout legible (logs
a clear failure on exhaustion), the unit gets to use `Restart=on-failure`
for self-healing, and a future contributor can read the wait-condition next
to the work it gates. The `usb-gadget.service` → `usb-gadget-setup.sh` pair
is the reference shape: 10 s poll for `/sys/class/udc` to populate, clean
exit-1 with a message if dwc2 never publishes.

If the precondition really is synchronous and unambiguous (a config file
the user wrote, the existence of a hardware feature already enumerated at
boot), `Condition*` is fine. The line is "does this become true
asynchronously after the unit's `After=` ordering?" — if yes, wait in the
script.
