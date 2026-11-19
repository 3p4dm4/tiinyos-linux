//! Minimal SHA-1 (FIPS 180-1). Only used for the RFC 6455 WebSocket
//! accept key; a few dozen short strings per process lifetime.
//! No dependencies, no `unsafe`, no early-exit tricks.

pub const BLOCK: usize = 64;

#[derive(Clone)]
pub struct Sha1 {
    h: [u32; 5],
    buf: [u8; BLOCK],
    buf_len: usize,
    total: u64,
}

impl Default for Sha1 {
    fn default() -> Self {
        Self::new()
    }
}

impl Sha1 {
    pub fn new() -> Self {
        Self {
            h: [
                0x6745_2301,
                0xEFCD_AB89,
                0x98BA_DCFE,
                0x1032_5476,
                0xC3D2_E1F0,
            ],
            buf: [0; BLOCK],
            buf_len: 0,
            total: 0,
        }
    }

    pub fn update(&mut self, mut data: &[u8]) {
        self.total = self.total.saturating_add(data.len() as u64);
        if self.buf_len > 0 {
            let need = BLOCK - self.buf_len;
            let take = need.min(data.len());
            self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            data = &data[take..];
            if self.buf_len == BLOCK {
                let block = self.buf;
                self.process_block(&block);
                self.buf_len = 0;
            }
        }
        while data.len() >= BLOCK {
            let block: [u8; BLOCK] = data[..BLOCK].try_into().unwrap();
            self.process_block(&block);
            data = &data[BLOCK..];
        }
        if !data.is_empty() {
            self.buf[..data.len()].copy_from_slice(data);
            self.buf_len = data.len();
        }
    }

    fn process_block(&mut self, block: &[u8; BLOCK]) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                block[i * 4],
                block[i * 4 + 1],
                block[i * 4 + 2],
                block[i * 4 + 3],
            ]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) =
            (self.h[0], self.h[1], self.h[2], self.h[3], self.h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let t = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
    }

    pub fn finish(mut self) -> [u8; 20] {
        let bits = self.total.wrapping_mul(8);
        let l = self.buf_len; // update() guarantees buf_len < BLOCK
        self.buf[l] = 0x80;
        self.buf[(l + 1)..BLOCK].fill(0);
        if l < 56 {
            self.buf[56..64].copy_from_slice(&bits.to_be_bytes());
            let block = self.buf;
            self.process_block(&block);
        } else {
            // not enough room for the length: finish this block, add another
            let block = self.buf;
            self.process_block(&block);
            let mut last = [0u8; BLOCK];
            last[56..64].copy_from_slice(&bits.to_be_bytes());
            self.process_block(&last);
        }
        let mut out = [0u8; 20];
        for (i, h) in self.h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&h.to_be_bytes());
        }
        out
    }

    pub fn update_and_finish(mut self, data: &[u8]) -> [u8; 20] {
        self.update(data);
        self.finish()
    }
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    Sha1::new().update_and_finish(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|c| format!("{c:02x}")).collect()
    }

    #[test]
    fn fips_vectors() {
        assert_eq!(hex(&sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex(&sha1(b"The quick brown fox jumps over the lazy dog")),
            "2fd4e1c67a2d28fced849ee1bb76e7391b93eb12"
        );
    }

    #[test]
    fn incremental_matches_oneshot() {
        let data = b"the quick brown fox jumps over the lazy dog, and again";
        let mut s = Sha1::new();
        for chunk in data.chunks(7) {
            s.update(chunk);
        }
        assert_eq!(hex(&s.finish()), hex(&sha1(data)));
    }

    #[test]
    fn rfc6455_accept_key() {
        use crate::base64;
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let expect = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";
        let digest = sha1(format!("{key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11").as_bytes());
        assert_eq!(base64::encode(&digest), expect);
    }
}
