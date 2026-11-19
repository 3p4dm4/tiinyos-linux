//! Tiny JSON: parse (for device.json and request bodies) and serialize.
//!
//! The serializer deliberately mirrors `json.dumps` from CPython (the
//! reference shim): default separators `", "` / `": "`, and
//! `ensure_ascii`-style escaping of non-ASCII and control characters.
//! The TiinyOS client parses this as JSON, but byte-level parity with the
//! Python shim is the easiest way to stay inside "the same shape".

pub type Json = Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&Vec<Value>> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Value::Int(i) => Some(*i),
            _ => None,
        }
    }

    pub fn is_number(&self) -> bool {
        matches!(self, Value::Int(_) | Value::Real(_))
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(Value::as_str)
    }

    /// First non-empty string among `keys`, in priority order.
    pub fn first_str(&self, keys: &[&str]) -> Option<&str> {
        for k in keys {
            if let Some(s) = self.get_str(k) {
                let t = s.trim();
                if !t.is_empty() {
                    return Some(t);
                }
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Builder helpers (insertion order is preserved, as in CPython dicts)

pub fn s(v: impl Into<String>) -> Value {
    Value::Str(v.into())
}
pub fn b(v: bool) -> Value {
    Value::Bool(v)
}
pub fn i(v: i64) -> Value {
    Value::Int(v)
}
pub fn n() -> Value {
    Value::Null
}
pub fn arr(items: Vec<Value>) -> Value {
    Value::Arr(items)
}
pub fn obj(pairs: Vec<(&str, Value)>) -> Value {
    Value::Obj(pairs.into_iter().map(|(k, v)| (k.to_owned(), v)).collect())
}

// ---------------------------------------------------------------------------
// Parsing

const MAX_DEPTH: usize = 32;

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            pos: 0,
        }
    }

    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b' ' | b'\t' | b'\n' | b'\r' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn parse(&mut self, depth: usize) -> Result<Value, String> {
        if depth > MAX_DEPTH {
            return Err("json too deep".into());
        }
        self.skip_ws();
        match self.peek() {
            Some(b'{') => self.parse_obj(depth),
            Some(b'[') => self.parse_arr(depth),
            Some(b'"') => Ok(Value::Str(self.parse_string()?)),
            Some(b't') => self.parse_lit("true", Value::Bool(true)),
            Some(b'f') => self.parse_lit("false", Value::Bool(false)),
            Some(b'n') => self.parse_lit("null", Value::Null),
            Some(c) if c == b'-' || c.is_ascii_digit() => self.parse_num(),
            Some(c) => Err(format!("unexpected byte {c:?} at {}", self.pos)),
            None => Err("unexpected end of input".into()),
        }
    }

    fn parse_lit(&mut self, lit: &str, v: Value) -> Result<Value, String> {
        if self.bytes[self.pos..].starts_with(lit.as_bytes()) {
            self.pos += lit.len();
            Ok(v)
        } else {
            Err(format!("bad literal at {}", self.pos))
        }
    }

    fn parse_num(&mut self) -> Result<Value, String> {
        let start = self.pos;
        while self
            .peek()
            .map(|c| {
                c == b'-' || c.is_ascii_digit() || c == b'.' || c == b'e' || c == b'E' || c == b'+'
            })
            .unwrap_or(false)
        {
            self.pos += 1;
        }
        let text = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "bad utf-8".to_string())?;
        if text.contains('.') || text.contains('e') || text.contains('E') {
            text.parse::<f64>()
                .map(Value::Real)
                .map_err(|e| e.to_string())
        } else {
            text.parse::<i64>()
                .map(Value::Int)
                .map_err(|e| e.to_string())
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        debug_assert_eq!(self.peek(), Some(b'"'));
        self.pos += 1;
        let mut out = String::new();
        loop {
            let c = self
                .peek()
                .ok_or_else(|| "unterminated string".to_string())?;
            match c {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let e = self
                        .peek()
                        .ok_or_else(|| "unterminated escape".to_string())?;
                    self.pos += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.parse_hex4()?;
                            // surrogate pairs: \uD800-\uDBFF followed by \uDC00-\uDFFF
                            if (0xD800..0xDC00).contains(&hi) {
                                if self.peek() == Some(b'\\') {
                                    let save = self.pos;
                                    self.pos += 1;
                                    if self.peek() == Some(b'u') {
                                        self.pos += 1;
                                        let lo = self.parse_hex4()?;
                                        if (0xDC00..0xE000).contains(&lo) {
                                            let cp =
                                                0x1_0000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                                            if let Some(ch) = char::from_u32(cp) {
                                                out.push(ch);
                                                continue;
                                            }
                                        }
                                    }
                                    self.pos = save;
                                }
                                out.push('\u{FFFD}');
                            } else if let Some(ch) = char::from_u32(hi) {
                                out.push(ch);
                            } else {
                                out.push('\u{FFFD}');
                            }
                        }
                        other => return Err(format!("bad escape \\{other:?}")),
                    }
                }
                _ if c < 0x20 => return Err("raw control char in string".into()),
                _ => {
                    // raw UTF-8: consume the whole code point
                    let rest = &self.bytes[self.pos..];
                    let len = utf8_len(c).unwrap_or(1);
                    if rest.len() < len {
                        return Err("truncated utf-8".into());
                    }
                    if let Ok(st) = std::str::from_utf8(&rest[..len]) {
                        out.push_str(st);
                    } else {
                        return Err("bad utf-8".into());
                    }
                    self.pos += len;
                }
            }
        }
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        if self.bytes.len() - self.pos < 4 {
            return Err("short \\u escape".into());
        }
        let mut v = 0u32;
        for k in 0..4 {
            let c = self.bytes[self.pos + k];
            let d = (c as char)
                .to_digit(16)
                .ok_or_else(|| "bad \\u escape".to_string())?;
            v = v * 16 + d;
        }
        self.pos += 4;
        Ok(v)
    }

    fn parse_obj(&mut self, depth: usize) -> Result<Value, String> {
        self.pos += 1; // {
        let mut pairs = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Value::Obj(pairs));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err("expected string key".into());
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err("expected ':'".into());
            }
            self.pos += 1;
            let val = self.parse(depth + 1)?;
            pairs.push((key, val));
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Value::Obj(pairs));
                }
                other => return Err(format!("bad object terminator {other:?}")),
            }
        }
    }

    fn parse_arr(&mut self, depth: usize) -> Result<Value, String> {
        self.pos += 1; // [
        let mut items = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Value::Arr(items));
        }
        loop {
            let val = self.parse(depth + 1)?;
            items.push(val);
            self.skip_ws();
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Value::Arr(items));
                }
                other => return Err(format!("bad array terminator {other:?}")),
            }
        }
    }
}

fn utf8_len(lead: u8) -> Option<usize> {
    if lead < 0x80 {
        Some(1)
    } else if (0xC0..0xE0).contains(&lead) {
        Some(2)
    } else if (0xE0..0xF0).contains(&lead) {
        Some(3)
    } else if (0xF0..0xF8).contains(&lead) {
        Some(4)
    } else {
        None
    }
}

pub fn parse(input: &str) -> Result<Value, String> {
    let mut p = Parser::new(input);
    let v = p.parse(0)?;
    p.skip_ws();
    if p.pos != p.bytes.len() {
        return Err(format!("trailing data at {}", p.pos));
    }
    Ok(v)
}

// ---------------------------------------------------------------------------
// Serialization (CPython json.dumps shape)

pub fn to_json(v: &Value) -> String {
    let mut out = String::with_capacity(128);
    write_value(&mut out, v);
    out
}

fn write_value(out: &mut String, v: &Value) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Int(n) => out.push_str(&n.to_string()),
        Value::Real(f) => out.push_str(&real_to_python_string(*f)),
        Value::Str(s) => write_string(out, s),
        Value::Arr(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push_str(", ");
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Obj(pairs) => {
            out.push('{');
            for (idx, (k, val)) in pairs.iter().enumerate() {
                if idx > 0 {
                    out.push_str(", ");
                }
                write_string(out, k);
                out.push_str(": ");
                write_value(out, val);
            }
            out.push('}');
        }
    }
}

fn real_to_python_string(f: f64) -> String {
    // Rust `{:?}` is shortest round-trip and appends `.0`, matching
    // Python's repr() for the values that occur in device.json.
    format!("{f:?}")
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{000C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c if (c as u32) < 0x7f => out.push(c),
            c => {
                // ensure_ascii: escape everything outside ASCII, as
                // surrogate pairs when above the BMP
                let cp = c as u32;
                if cp <= 0xFFFF {
                    out.push_str(&format!("\\u{:04x}", cp));
                } else {
                    let u = cp - 0x1_0000;
                    let hi = 0xD800 + (u >> 10);
                    let lo = 0xDC00 + (u & 0x3FF);
                    out.push_str(&format!("\\u{:04x}\\u{:04x}", hi, lo));
                }
            }
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_objects_and_arrays() {
        let v = obj(vec![
            ("event", s("connection")),
            (
                "data",
                obj(vec![
                    ("devices", arr(vec![])),
                    ("local_devices", arr(vec![])),
                    ("selected_device", n()),
                ]),
            ),
        ]);
        assert_eq!(
            to_json(&v),
            "{\"event\": \"connection\", \"data\": {\"devices\": [], \"local_devices\": [], \"selected_device\": null}}"
        );
        let back = parse(&to_json(&v)).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn ensure_ascii_escapes() {
        let v = s("caf\u{00E9} \u{1F600} \u{4e2d}");
        let out = to_json(&v);
        assert_eq!(out, "\"caf\\u00e9 \\ud83d\\ude00 \\u4e2d\"");
        assert_eq!(parse(&out).unwrap(), v);
    }

    #[test]
    fn control_chars_and_escapes() {
        let v = s("a\nb\tc\"d\\e");
        let out = to_json(&v);
        assert_eq!(out, "\"a\\nb\\tc\\\"d\\\\e\"");
        assert_eq!(parse(&out).unwrap(), v);
    }

    #[test]
    fn parse_numbers_bools_null() {
        assert_eq!(parse("123").unwrap(), Value::Int(123));
        assert_eq!(parse("-42").unwrap(), Value::Int(-42));
        assert_eq!(parse("1.5").unwrap(), Value::Real(1.5));
        assert_eq!(parse("true").unwrap(), Value::Bool(true));
        assert_eq!(parse("null").unwrap(), Value::Null);
    }

    #[test]
    fn parse_nested_and_unicode_escape() {
        let v = parse(r#"{"a": [1, {"b": "x\ud83d\ude00y"}], "c": "é"}"#).unwrap();
        assert_eq!(v.get_str("a"), None); // it's an array
        let a = v.get("a").unwrap();
        assert_eq!(
            a,
            &Value::Arr(vec![
                Value::Int(1),
                Value::Obj(vec![("b".into(), s("x\u{1F600}y"))]),
            ])
        );
        assert_eq!(v.get_str("c"), Some("é"));
    }

    #[test]
    fn rejects_garbage_and_depth() {
        assert!(parse("{").is_err());
        assert!(parse("{\"a\": 1,}").is_err());
        assert!(parse("[1 2]").is_err());
        assert!(parse("nul").is_err());
        let mut s = String::from("[");
        for _ in 0..40 {
            s.push('[');
        }
        s.push('1');
        for _ in 0..40 {
            s.push(']');
        }
        assert!(parse(&s).is_err());
    }

    #[test]
    fn first_str_priority() {
        let v = obj(vec![
            ("serial", s("  ")),
            ("serial_number", s("TESTSN000000000001")),
            ("device_id", s("other")),
        ]);
        assert_eq!(
            v.first_str(&["serial_number", "serial", "device_id"]),
            Some("TESTSN000000000001")
        );
        assert_eq!(v.first_str(&["device_id"]), Some("other"));
    }
}
