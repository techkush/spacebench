# -*- coding: utf-8 -*-
# Space Bench helper, run inside Renode's monitor (IronPython). It lets Space Bench drive an
# emulated board in lockstep with the circuit:
#   sb_setup(spec)          hook every GPIO line, capture the UARTs
#   sb_step(inputs, secs)   inputs in, exactly `secs` of virtual time, then one line:
#                           __SB__{"start": [[pin, out, pu, pd]...], "events": [[pin, t, out, pu, pd]...], "uart": {...}}
#   sb_uart(name, text)     type into a UART (the Serial Monitor)
# Pins are named like the board's ("PA0", "PD12", "P0.13"); out is 1/0 when the pin drives,
# -1 when it is an input; pu/pd are its pull resistors, read from the GPIO registers.
import clr
import json
from System import Action, Byte

_m = monitor.Machine
_bus = _m.SystemBus
SB = {"ports": [], "levels": {}, "ev": [], "uart": {}, "t0": 0.0, "clock": 0}


def _now():
    return _m.LocalTimeSource.ElapsedVirtualTime.TotalSeconds


def _hook(name):
    def h(v):
        SB["levels"][name] = bool(v)
        SB["ev"].append((name, _now(), bool(v)))
    return Action[bool](h)


def _rx(name):
    def h(b):
        SB["uart"][name].append(chr(b))
    return Action[Byte](h)


def sb_setup(spec):
    """spec: {"ports": [{"name": "gpioPortA", "prefix": "PA", "family": "stm32f4", "base": 0x40020000}...], "uarts": ["usart2"]}"""
    spec = json.loads(spec)
    for p in spec["ports"]:
        per = _m["sysbus." + p["name"]]
        SB["ports"].append((per, p))
        for kv in per.Connections:
            pin = p["prefix"] + str(kv.Key)
            SB["levels"][pin] = bool(kv.Value.IsSet)
            kv.Value.AddStateChangedHook(_hook(pin))
    for u in spec["uarts"]:
        SB["uart"][u] = []
        _m["sysbus." + u].CharReceived += _rx(u)
    print("__SB__" + json.dumps({"ok": True}))


def _rd(addr):
    return int(_bus.ReadDoubleWord(addr))


def _modes():
    """pin -> (output?, pull-up?, pull-down?) for every pin of every port, from its registers"""
    out = {}
    for per, p in SB["ports"]:
        fam, base = p["family"], int(p["base"])
        n = per.NumberOfConnections if hasattr(per, "NumberOfConnections") else 16
        if fam == "stm32f4":
            moder, pupdr = _rd(base), _rd(base + 0x0C)
            for i in range(16):
                mode, pull = (moder >> (2 * i)) & 3, (pupdr >> (2 * i)) & 3
                out[p["prefix"] + str(i)] = (mode == 1, pull == 1, pull == 2)
        elif fam == "stm32f1":
            crl, crh, odr = _rd(base), _rd(base + 4), _rd(base + 0x0C)
            for i in range(16):
                cr = ((crl if i < 8 else crh) >> (4 * (i % 8))) & 0xF
                mode, cnf = cr & 3, cr >> 2
                pulled = mode == 0 and cnf == 2
                up = pulled and (odr >> i) & 1 == 1
                out[p["prefix"] + str(i)] = (mode != 0 and cnf < 2, up, pulled and not up)
        elif fam == "nrf52":
            # the peripheral sits at 0x...500: OUT +0x04, DIR +0x14, PIN_CNF[n] +0x200 + 4n
            d = _rd(base + 0x14)
            for i in range(32):
                pull = (_rd(base + 0x200 + 4 * i) >> 2) & 3
                out[p["prefix"] + str(i)] = ((d >> i) & 1 == 1, pull == 3, pull == 1)
    return out


def _state(pin, modes):
    drive, pu, pd = modes.get(pin, (False, False, False))
    if drive:
        return [pin, 1 if SB["levels"].get(pin) else 0, False, False]
    return [pin, -1, pu, pd]


def _clock():
    # Space Bench's builds set SystemCoreClock; the emulated SysTick follows it
    try:
        hz = _rd(_bus.GetSymbolAddress("SystemCoreClock"))
        if hz and hz != SB["clock"]:
            _m["sysbus.nvic"].Frequency = hz
            SB["clock"] = hz
    except Exception:
        pass


def sb_step(inputs, secs):
    inputs = json.loads(inputs)
    for per, p in SB["ports"]:
        for pin, high in inputs.items():
            if pin.startswith(p["prefix"]) and pin[len(p["prefix"]):].isdigit():
                per.OnGPIO(int(pin[len(p["prefix"]):]), bool(high))
    modes = _modes()
    start = [_state(pin, modes) for pin in modes]
    t0 = _now()
    SB["ev"] = []
    monitor.Parse('emulation RunFor "%.9f"' % float(secs))
    _clock()
    modes2 = _modes()
    events = []
    for pin, t, v in SB["ev"]:
        drive, pu, pd = modes2.get(pin, (True, False, False))
        events.append([pin, max(0.0, t - t0), (1 if v else 0) if drive else -1, pu and not drive, pd and not drive])
    # pins whose mode changed during the frame (pinMode) end in their new state
    for pin in modes2:
        if modes2[pin] != modes.get(pin):
            s = _state(pin, modes2)
            events.append([pin, float(secs), s[1], s[2], s[3]])
    uart = {}
    for u, chars in SB["uart"].items():
        if chars:
            uart[u] = "".join(chars)
            del chars[:]
    print("__SB__" + json.dumps({"start": start, "events": events, "uart": uart, "t": float(secs)}))


def sb_uart(name, text):
    u = _m["sysbus." + name]
    for ch in text:
        u.WriteChar(Byte(ord(ch) & 0xFF))
    print("__SB__" + json.dumps({"ok": True}))
