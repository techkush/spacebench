// Monaco (the VS Code editor) for sketches, bundled locally — no CDN, works offline in the app.
// C++ highlighting comes from Monaco's basic languages; Arduino's API gets completions here.
import { loader } from "@monaco-editor/react"
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js"
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js"
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js"
import "monaco-editor/esm/vs/language/json/monaco.contribution.js"
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker"
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker"

self.MonacoEnvironment = {
  getWorker: (_id: string, label: string) => (label === "json" ? new JsonWorker() : new EditorWorker()),
}
loader.config({ monaco })

const API: [string, string, string][] = [
  ["pinMode", "pinMode(${1:pin}, ${2|OUTPUT,INPUT,INPUT_PULLUP|})", "Configure a pin as input or output"],
  ["digitalWrite", "digitalWrite(${1:pin}, ${2|HIGH,LOW|})", "Set a digital pin HIGH or LOW"],
  ["digitalRead", "digitalRead(${1:pin})", "Read a digital pin (HIGH / LOW)"],
  ["analogRead", "analogRead(${1:A0})", "Read an analog pin: 0–1023 for 0–5 V"],
  ["analogWrite", "analogWrite(${1:pin}, ${2:value})", "PWM output, 0–255 (pins 3, 5, 6, 9, 10, 11 on the Uno)"],
  ["delay", "delay(${1:ms})", "Wait milliseconds"],
  ["delayMicroseconds", "delayMicroseconds(${1:us})", "Wait microseconds"],
  ["millis", "millis()", "Milliseconds since start"],
  ["micros", "micros()", "Microseconds since start"],
  ["tone", "tone(${1:pin}, ${2:frequency}${3:, duration})", "Square wave on a pin (buzzer)"],
  ["noTone", "noTone(${1:pin})", "Stop tone()"],
  ["map", "map(${1:value}, ${2:fromLow}, ${3:fromHigh}, ${4:toLow}, ${5:toHigh})", "Re-map a number from one range to another"],
  ["constrain", "constrain(${1:x}, ${2:a}, ${3:b})", "Limit a number to a range"],
  ["pulseIn", "pulseIn(${1:pin}, ${2|HIGH,LOW|})", "Length of a pulse in microseconds"],
  ["attachInterrupt", "attachInterrupt(digitalPinToInterrupt(${1:2}), ${2:isr}, ${3|RISING,FALLING,CHANGE|})", "Run a function on a pin edge"],
  ["Serial.begin", "Serial.begin(${1:9600})", "Start the serial port"],
  ["Serial.println", "Serial.println(${1})", "Print a line to the Serial Monitor"],
  ["Serial.print", "Serial.print(${1})", "Print to the Serial Monitor"],
  ["Serial.available", "Serial.available()", "Bytes waiting from the Serial Monitor"],
  ["Serial.read", "Serial.read()", "Read one byte from the Serial Monitor"],
  ["setup", "void setup() {\n\t$0\n}", "Runs once at start"],
  ["loop", "void loop() {\n\t$0\n}", "Runs over and over"],
]

let done = false
export function setupArduino() {
  if (done) return
  done = true
  monaco.languages.registerCompletionItemProvider("cpp", {
    provideCompletionItems(model, position) {
      const w = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: w.startColumn, endColumn: w.endColumn }
      return {
        suggestions: [
          ...API.map(([label, insert, doc]) => ({ label, kind: monaco.languages.CompletionItemKind.Function, insertText: insert, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, documentation: doc, range })),
          ...["HIGH", "LOW", "INPUT", "OUTPUT", "INPUT_PULLUP", "LED_BUILTIN", "A0", "A1", "A2", "A3", "A4", "A5"].map((k) => ({ label: k, kind: monaco.languages.CompletionItemKind.Constant, insertText: k, range })),
        ],
      }
    },
  })
  monaco.editor.defineTheme("sb-dark", { base: "vs-dark", inherit: true, rules: [], colors: { "editor.background": "#0a0a0a", "editorGutter.background": "#0a0a0a", "editor.lineHighlightBackground": "#ffffff08" } })
  monaco.editor.defineTheme("sb-light", { base: "vs", inherit: true, rules: [], colors: { "editor.background": "#ffffff", "editor.lineHighlightBackground": "#00000006" } })
}

export { monaco }
