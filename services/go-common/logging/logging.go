// SPDX-License-Identifier: Apache-2.0
// Package logging emits one-line structured JSON logs in the
// {"severity": ..., "kind": ..., "event": ..., <fields>} shape. Cloud Logging
// (and most log aggregators) parse the `severity` field natively;
// `jsonPayload.event` is the searchable key (e.g. event=ledger_load_failed).
//
// Rules (BINDING):
//   - a log call NEVER panics or throws — marshal failures degrade to a
//     minimal fallback line;
//   - no secrets, no content, no high-cardinality identity in fields.
package logging

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Fields is one log line's structured payload.
type Fields map[string]any

// Logger writes structured JSON lines. The zero value is not usable; use New.
type Logger struct {
	mu   sync.Mutex
	out  io.Writer
	kind string
	base Fields
}

// New builds a Logger that stamps every line with kind (the searchable
// namespace, e.g. "agix.coord-mcp") and the base fields (typically
// {"service": ..., "version": ...}). Output defaults to os.Stdout.
func New(kind string, base Fields) *Logger {
	copied := make(Fields, len(base))
	for k, v := range base {
		copied[k] = v
	}
	return &Logger{out: os.Stdout, kind: kind, base: copied}
}

// SetOutput redirects the logger (tests). Not for production use.
func (l *Logger) SetOutput(w io.Writer) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.out = w
}

// Info logs at severity INFO.
func (l *Logger) Info(event string, fields Fields) { l.log("INFO", event, fields) }

// Warn logs at severity WARNING (Cloud Logging's spelling).
func (l *Logger) Warn(event string, fields Fields) { l.log("WARNING", event, fields) }

// Error logs at severity ERROR.
func (l *Logger) Error(event string, fields Fields) { l.log("ERROR", event, fields) }

// Fatal logs at severity CRITICAL and exits(1). Startup-abort only.
func (l *Logger) Fatal(event string, fields Fields) {
	l.log("CRITICAL", event, fields)
	osExit(1)
}

// osExit is swapped in tests.
var osExit = os.Exit

func (l *Logger) log(severity, event string, fields Fields) {
	line := make(map[string]any, len(l.base)+len(fields)+4)
	line["severity"] = severity
	line["time"] = time.Now().UTC().Format(time.RFC3339Nano)
	if l.kind != "" {
		line["kind"] = l.kind
	}
	line["event"] = event
	for k, v := range l.base {
		line[k] = v
	}
	for k, v := range fields {
		line[k] = v
	}

	buf, err := json.Marshal(line)
	if err != nil {
		// NEVER panic from a log call: stringify unmarshalable values.
		for k, v := range line {
			line[k] = fmt.Sprint(v)
		}
		if buf, err = json.Marshal(line); err != nil {
			buf = fmt.Appendf(nil, `{"severity":%q,"kind":%q,"event":%q,"logging_error":"unmarshalable fields"}`,
				severity, l.kind, event)
		}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.out.Write(append(buf, '\n'))
}
