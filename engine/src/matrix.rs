//! Linear solver for the MNA system `G·x = b`.
//!
//! v0.1 uses dense LU with partial pivoting (fine up to a few hundred unknowns).
//! A sparse LU with AMD ordering will replace this behind the
//! same interface later.

use num_complex::Complex64;
use std::ops::{AddAssign, Div, Mul, Sub};

pub trait Scalar:
    Copy + Default + AddAssign + Sub<Output = Self> + Mul<Output = Self> + Div<Output = Self>
{
    fn magnitude(self) -> f64;
}
impl Scalar for f64 {
    fn magnitude(self) -> f64 {
        self.abs()
    }
}
impl Scalar for Complex64 {
    fn magnitude(self) -> f64 {
        self.norm()
    }
}

#[derive(Debug, Clone)]
pub struct Dense<T: Scalar> {
    pub n: usize,
    a: Vec<T>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Singular {
    /// Unknown index whose pivot vanished.
    pub unknown: usize,
}

impl<T: Scalar> Dense<T> {
    pub fn new(n: usize) -> Self {
        Self { n, a: vec![T::default(); n * n] }
    }

    pub fn clear(&mut self) {
        self.a.iter_mut().for_each(|v| *v = T::default());
    }

    #[inline]
    pub fn add(&mut self, r: usize, c: usize, v: T) {
        self.a[r * self.n + c] += v;
    }

    #[inline]
    pub fn get(&self, r: usize, c: usize) -> T {
        self.a[r * self.n + c]
    }

    /// Solve in place (destroys the matrix). Returns x.
    pub fn solve(&mut self, b: &[T]) -> Result<Vec<T>, Singular> {
        let n = self.n;
        let mut x: Vec<T> = b.to_vec();
        let mut perm: Vec<usize> = (0..n).collect();
        let scale = self.a.iter().map(|v| v.magnitude()).fold(0.0, f64::max).max(1e-300);
        for k in 0..n {
            // partial pivoting
            let (mut p, mut best) = (k, self.a[perm[k] * n + k].magnitude());
            for i in k + 1..n {
                let m = self.a[perm[i] * n + k].magnitude();
                if m > best {
                    best = m;
                    p = i;
                }
            }
            if best <= 1e-18 * scale {
                return Err(Singular { unknown: k });
            }
            perm.swap(k, p);
            let pk = perm[k];
            let piv = self.a[pk * n + k];
            for i in k + 1..n {
                let pi = perm[i];
                let f = self.a[pi * n + k] / piv;
                if f.magnitude() == 0.0 {
                    continue;
                }
                for j in k..n {
                    let v = self.a[pk * n + j];
                    let cur = self.a[pi * n + j];
                    self.a[pi * n + j] = cur - f * v;
                }
                let xb = x[pk];
                let xi = x[pi];
                x[pi] = xi - f * xb;
            }
        }
        // back substitution
        let mut out = vec![T::default(); n];
        for k in (0..n).rev() {
            let pk = perm[k];
            let mut s = x[pk];
            for j in k + 1..n {
                s = s - self.a[pk * n + j] * out[j];
            }
            out[k] = s / self.a[pk * n + k];
        }
        Ok(out)
    }
}
