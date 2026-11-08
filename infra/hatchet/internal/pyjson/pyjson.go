// Package pyjson decodes JSON with object key order preserved and encodes it
// byte-for-byte like Python's json.dumps(value, ensure_ascii=True).
//
// The ASN pipeline used to be Python; keeping its exact serialization lets the
// Go job compare rows with md5(json) in Postgres instead of reading them back.
package pyjson

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/big"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Member is one key/value pair of an Object.
type Member struct {
	Key   string
	Value any
}

// Object is a JSON object that keeps insertion order, like a Python dict.
type Object struct {
	Members []Member
}

// Get returns the value for key and whether it is present.
func (o *Object) Get(key string) (any, bool) {
	for _, m := range o.Members {
		if m.Key == key {
			return m.Value, true
		}
	}
	return nil, false
}

// Value returns the value for key, or nil when absent (Python dict.get).
func (o *Object) Value(key string) any {
	v, _ := o.Get(key)
	return v
}

// Has reports whether key is present.
func (o *Object) Has(key string) bool {
	_, ok := o.Get(key)
	return ok
}

// Set assigns key, keeping its original position when it already exists.
func (o *Object) Set(key string, value any) {
	for i := range o.Members {
		if o.Members[i].Key == key {
			o.Members[i].Value = value
			return
		}
	}
	o.Members = append(o.Members, Member{Key: key, Value: value})
}

// Copy returns a shallow copy (Python dict.copy / dict.update into an empty dict).
func (o *Object) Copy() *Object {
	members := make([]Member, len(o.Members))
	copy(members, o.Members)
	return &Object{Members: members}
}

// Decode parses one JSON document. Objects become *Object, arrays []any,
// numbers json.Number, and the rest string, bool, or nil.
func Decode(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	value, err := decodeValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("unexpected data after JSON value")
	}
	return value, nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := &Object{}
			for dec.More() {
				keyTok, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyTok.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string")
				}
				value, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				obj.Set(key, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				value, err := decodeValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, value)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
		return nil, fmt.Errorf("unexpected delimiter %v", t)
	default:
		return tok, nil
	}
}

// Dumps encodes value like Python's json.dumps(value, ensure_ascii=True).
func Dumps(value any) (string, error) {
	var b strings.Builder
	if err := encode(&b, value); err != nil {
		return "", err
	}
	return b.String(), nil
}

func encode(b *strings.Builder, value any) error {
	switch v := value.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		if v {
			b.WriteString("true")
		} else {
			b.WriteString("false")
		}
	case string:
		writeString(b, v)
	case json.Number:
		text, err := numberText(v)
		if err != nil {
			return err
		}
		b.WriteString(text)
	case int:
		b.WriteString(strconv.Itoa(v))
	case int64:
		b.WriteString(strconv.FormatInt(v, 10))
	case *Object:
		if len(v.Members) == 0 {
			b.WriteString("{}")
			return nil
		}
		b.WriteByte('{')
		for i, m := range v.Members {
			if i > 0 {
				b.WriteString(", ")
			}
			writeString(b, m.Key)
			b.WriteString(": ")
			if err := encode(b, m.Value); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	case []any:
		if len(v) == 0 {
			b.WriteString("[]")
			return nil
		}
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteString(", ")
			}
			if err := encode(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	case []string:
		items := make([]any, len(v))
		for i, s := range v {
			items[i] = s
		}
		return encode(b, items)
	default:
		return fmt.Errorf("pyjson: unsupported type %T", value)
	}
	return nil
}

// writeString mirrors Python's ensure_ascii escaping: everything outside
// printable ASCII becomes \uXXXX (lowercase hex, surrogate pairs above BMP).
func writeString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		default:
			if r >= 0x20 && r <= 0x7e {
				b.WriteRune(r)
				continue
			}
			if r == utf8.RuneError {
				r = 0xfffd
			}
			if r > 0xffff {
				r -= 0x10000
				fmt.Fprintf(b, `\u%04x\u%04x`, 0xd800|(r>>10), 0xdc00|(r&0x3ff))
				continue
			}
			fmt.Fprintf(b, `\u%04x`, r)
		}
	}
	b.WriteByte('"')
}

// IsInteger reports whether a JSON number literal parses as a Python int.
func IsInteger(n json.Number) bool {
	return !strings.ContainsAny(string(n), ".eE")
}

func numberText(n json.Number) (string, error) {
	if IsInteger(n) {
		i, ok := new(big.Int).SetString(string(n), 10)
		if !ok {
			return "", fmt.Errorf("pyjson: invalid integer %q", n)
		}
		return i.String(), nil
	}
	f, err := strconv.ParseFloat(string(n), 64)
	if err != nil && !isRangeErr(err) {
		return "", fmt.Errorf("pyjson: invalid float %q", n)
	}
	return FloatRepr(f), nil
}

func isRangeErr(err error) bool {
	numErr, ok := err.(*strconv.NumError)
	return ok && numErr.Err == strconv.ErrRange
}

// FloatRepr formats f like Python's repr(float) as used by json.dumps.
func FloatRepr(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	}
	sci := strconv.FormatFloat(f, 'e', -1, 64) // e.g. -1.2345e+06
	sign := ""
	if sci[0] == '-' {
		sign = "-"
		sci = sci[1:]
	}
	mantissa, expText, _ := strings.Cut(sci, "e")
	exp, _ := strconv.Atoi(expText)
	digits := strings.Replace(mantissa, ".", "", 1)

	if exp < -4 || exp >= 16 {
		m := digits[:1]
		if len(digits) > 1 {
			m += "." + digits[1:]
		}
		expSign := "+"
		if exp < 0 {
			expSign = "-"
			exp = -exp
		}
		return fmt.Sprintf("%s%se%s%02d", sign, m, expSign, exp)
	}

	var out string
	if exp < 0 {
		out = "0." + strings.Repeat("0", -exp-1) + digits
	} else if len(digits) <= exp+1 {
		out = digits + strings.Repeat("0", exp+1-len(digits)) + ".0"
	} else {
		out = digits[:exp+1] + "." + digits[exp+1:]
	}
	return sign + out
}

// Str mirrors Python's str() for decoded JSON scalars.
func Str(value any) (string, bool) {
	switch v := value.(type) {
	case string:
		return v, true
	case bool:
		if v {
			return "True", true
		}
		return "False", true
	case json.Number:
		text, err := numberText(v)
		return text, err == nil
	case int:
		return strconv.Itoa(v), true
	case nil:
		return "None", true
	}
	// Containers: Python would print its repr; callers treat this as unsupported.
	return "", false
}

// Equal mirrors Python's == on decoded JSON values (dicts compare unordered).
func Equal(a, b any) bool {
	switch av := a.(type) {
	case *Object:
		bv, ok := b.(*Object)
		if !ok || len(av.Members) != len(bv.Members) {
			return false
		}
		for _, m := range av.Members {
			other, ok := bv.Get(m.Key)
			if !ok || !Equal(m.Value, other) {
				return false
			}
		}
		return true
	case []any:
		bv, ok := b.([]any)
		if !ok || len(av) != len(bv) {
			return false
		}
		for i := range av {
			if !Equal(av[i], bv[i]) {
				return false
			}
		}
		return true
	case json.Number:
		bv, ok := b.(json.Number)
		if !ok {
			return false
		}
		af, aerr := strconv.ParseFloat(string(av), 64)
		bf, berr := strconv.ParseFloat(string(bv), 64)
		if aerr != nil || berr != nil {
			return av == bv
		}
		return af == bf
	default:
		return a == b
	}
}
