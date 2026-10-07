pub fn quote(arg: &str) -> String {
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| matches!(c, ' ' | '\t' | '\n' | '\r' | '"'))
    {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut slashes = 0;
    for c in arg.chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            '\\',
            if c == '"' { slashes * 2 + 1 } else { slashes },
        ));
        slashes = 0;
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_and_space() {
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("a b"), "\"a b\"");
    }
    #[test]
    fn quote_and_trailing_slash() {
        assert_eq!(quote("a\"b"), "\"a\\\"b\"");
        assert_eq!(quote("a b\\"), "\"a b\\\\\"");
    }
    #[test]
    fn plain_is_unchanged() {
        assert_eq!(quote("C:\\a\\b.exe"), "C:\\a\\b.exe");
    }
}
