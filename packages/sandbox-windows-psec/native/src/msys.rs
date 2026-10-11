//! Private controller for the owned MSYS adapter; never parses workload output.
use crate::{
    error::{Error, Result},
    transport::Input,
};

pub enum Observation {
    Ready,
    Ack(String, Result<()>),
    Root(u32),
}
pub fn packet(input: &Input) -> Result<Vec<u8>> {
    let (kind, id, data) = match input {
        Input::Bytes(id, data) => (1, id, data.clone()),
        Input::End(id) => (2, id, Vec::new()),
        Input::Stop(id) => (4, id, Vec::new()),
        Input::Resize(id, cols, rows) => (
            3,
            id,
            [(*cols as u16).to_le_bytes(), (*rows as u16).to_le_bytes()].concat(),
        ),
    };
    if !identifier(id) || data.len() > 16384 {
        return Err(Error::invalid("invalid MSYS controller frame"));
    }
    let mut packet = vec![kind, id.len() as u8, 0, 0];
    packet.extend_from_slice(&(data.len() as u32).to_le_bytes());
    packet.extend_from_slice(id.as_bytes());
    packet.extend_from_slice(&data);
    Ok(packet)
}
pub fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:".contains(&c))
}
pub fn observation(line: &[u8]) -> Result<Observation> {
    if line.len() > 256 {
        return Err(Error::state("MSYS controller line limit exceeded"));
    }
    let text =
        std::str::from_utf8(line).map_err(|_| Error::state("invalid MSYS controller UTF8"))?;
    let fields = text
        .trim_end_matches(['\r', '\n'])
        .split(' ')
        .collect::<Vec<_>>();
    match fields.as_slice() {
        ["READY"] => Ok(Observation::Ready),
        ["ACK", id, code] if identifier(id) => {
            let code = code
                .parse::<u32>()
                .map_err(|_| Error::state("invalid MSYS acknowledgement"))?;
            Ok(Observation::Ack(
                (*id).into(),
                if code == 0 {
                    Ok(())
                } else if code == 11 {
                    Err(Error {
                        code: "input-backpressure",
                        ..Error::native_code("MSYS input queue full; no bytes queued", code)
                    })
                } else {
                    Err(Error::native_code("MSYS PTY operation", code))
                },
            ))
        }
        ["ROOT", code] => {
            let code = code
                .parse::<u32>()
                .map_err(|_| Error::state("invalid MSYS root status"))?;
            if code > 255 {
                return Err(Error::state("invalid MSYS exit code"));
            }
            Ok(Observation::Root(code))
        }
        ["INPUT_ERROR", id, code] if identifier(id) => {
            let code = code
                .parse::<u32>()
                .map_err(|_| Error::state("invalid MSYS input failure"))?;
            if code == 0 {
                return Err(Error::state("MSYS input failure has success code"));
            }
            Ok(Observation::Ack(
                (*id).into(),
                Err(Error::native_code(
                    "MSYS master delivery; bytes may be partial",
                    code,
                )),
            ))
        }
        ["ERROR", api, code] if identifier(api) => Err(Error::native_code(
            &format!("MSYS {api}"),
            code.parse::<u32>()
                .map_err(|_| Error::state("invalid MSYS error"))?,
        )),
        _ => Err(Error::state("invalid MSYS controller observation")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn control_frames_keep_raw_bytes_and_encode_dimensions() {
        let bytes = vec![0, 3, 13, 10, 0xff, 0xe4, 0xb8, 0xad];
        let packet = packet(&Input::Bytes("r1".into(), bytes.clone())).unwrap();
        assert_eq!(&packet[..8], &[1, 2, 0, 0, 8, 0, 0, 0]);
        assert_eq!(&packet[10..], bytes);
        assert_eq!(
            &super::packet(&Input::Resize("r2".into(), 143, 37)).unwrap()[10..],
            &[143, 0, 37, 0]
        );
        assert!(super::packet(&Input::Bytes("bad\nROOT 0".into(), vec![])).is_err());
    }
    #[test]
    fn observations_are_bounded_and_do_not_accept_workload_text() {
        assert!(matches!(
            observation(b"ACK r1 0\n").unwrap(),
            Observation::Ack(_, Ok(()))
        ));
        assert!(matches!(
            observation(b"ROOT 130\n").unwrap(),
            Observation::Root(130)
        ));
        for bad in [
            b"ROOT 256\n".as_slice(),
            b"ROOT -1\n",
            b"ACK r1 0 extra\n",
            b"echo READY\n",
            &[b'A'; 257],
        ] {
            assert!(observation(bad).is_err());
        }
    }
    #[test]
    fn physical_input_failure_is_not_safe_backpressure_retry() {
        let Observation::Ack(_, Err(queue)) = observation(b"ACK r1 11\n").unwrap() else {
            panic!("queue rejection expected")
        };
        let Observation::Ack(_, Err(delivery)) = observation(b"INPUT_ERROR r2 11\n").unwrap()
        else {
            panic!("physical failure expected")
        };
        assert_eq!(queue.code, "input-backpressure");
        assert_eq!(delivery.code, "native-failure");
        assert!(delivery.api.contains("bytes may be partial"));
        assert!(observation(b"INPUT_ERROR r3 0\n").is_err());
    }
}
