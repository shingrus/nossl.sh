package pyjson

import "testing"

// Expected values come from CPython: json.dumps(json.loads(input), ensure_ascii=True).
func TestDumpsMatchesPython(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{
			`{"a": 1, "b": [1, 2.5, "x"], "c": {}, "d": []}`,
			`{"a": 1, "b": [1, 2.5, "x"], "c": {}, "d": []}`,
		},
		{
			`{"s": "caf\u00e9 \ud83d\ude00 \"q\" \\ \n\t\r\b\f \u0001 \u007f /"}`,
			`{"s": "caf\u00e9 \ud83d\ude00 \"q\" \\ \n\t\r\b\f \u0001 \u007f /"}`,
		},
		{
			`[1.0, 1e5, 1E-5, 123456789012345678, 1e16, 1.5e16, 0.0001, 0.00001, -0.0, 3.14159, 1e400, 12345678901234567890123]`,
			`[1.0, 100000.0, 1e-05, 123456789012345678, 1e+16, 1.5e+16, 0.0001, 1e-05, -0.0, 3.14159, Infinity, 12345678901234567890123]`,
		},
		{
			`{"k": 1, "k2": 2, "k": 3}`,
			`{"k": 3, "k2": 2}`,
		},
		{
			`[true, false, null, -0, 100]`,
			`[true, false, null, 0, 100]`,
		},
	}
	for _, tc := range cases {
		value, err := Decode([]byte(tc.input))
		if err != nil {
			t.Fatalf("Decode(%s): %v", tc.input, err)
		}
		got, err := Dumps(value)
		if err != nil {
			t.Fatalf("Dumps(%s): %v", tc.input, err)
		}
		if got != tc.want {
			t.Errorf("Dumps(%s)\n got: %s\nwant: %s", tc.input, got, tc.want)
		}
	}
}
