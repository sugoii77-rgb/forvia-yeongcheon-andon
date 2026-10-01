'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/client';

/**
 * "Google로 로그인" (or, with `linking`, "Google 계정 연결" for an existing local account).
 * Hidden when the server reports that Google login is not configured.
 * Linking requires the current local password (re-authentication) — see googleAuth.ts beginGoogle().
 */
export function GoogleLogin({ linking = false }: { linking?: boolean }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    let active = true;
    api<{ configured: boolean }>('/api/auth/google/start').then(
      (r) => active && setConfigured(r.configured),
      () => active && setConfigured(false),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (new URLSearchParams(location.search).get('googleError')) {
      timer = setTimeout(
        () => setError('Google 인증이 취소되었거나 만료되었습니다. 다시 시도하세요. 계속 실패하면 관리자에게 문의하세요.'),
        0,
      );
    }
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  async function start() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ url: string }>('/api/auth/google/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: linking ? 'link' : 'login',
          password: linking ? password : undefined,
          next: linking ? '/me' : new URLSearchParams(location.search).get('next'),
        }),
      });
      location.assign(result.url);
    } catch (e) {
      setError((e as Error).message);
      setPassword('');
      setBusy(false);
    }
  }

  if (!configured) return null;
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      {linking && (
        <div className="field">
          <label htmlFor="link-password">기존 계정 비밀번호 확인</label>
          <input
            id="link-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      )}
      <button className="btn btn-big btn-block" onClick={start} disabled={busy || (linking && !password)}>
        {busy ? '연결 중…' : linking ? 'Google 계정 연결' : 'Google로 로그인'}
      </button>
      <p className="muted" style={{ fontSize: 14, marginTop: 10 }}>
        {linking
          ? '현재 계정의 사번·부서·권한을 유지하며 Google 로그인을 추가합니다. 비밀번호 재확인이 필요합니다.'
          : '회사 이메일이 없어도 Google 계정으로 시작할 수 있습니다. 기존 로컬 계정은 로그인 후 내 정보에서 연결하세요.'}
      </p>
      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
