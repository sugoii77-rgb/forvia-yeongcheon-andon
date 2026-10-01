'use client';
// Google onboarding: after a verified Google sign-in that is not yet linked to an employee.
// New employee → enter employee data. Linking (started from 내 정보 with password re-check) →
// only employee ID (if not set yet) and contact fields; name / department / role stay unchanged.
// The Google identity itself is held on the server (never sent from this page).
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { TopBar } from '@/components/TopBar';
import { api } from '@/lib/client';
import type { MasterData } from '@/lib/domain';

type Info = {
  email: string;
  name: string;
  linking: boolean;
  employee: null | {
    employee_id: string | null;
    name: string;
    phone: string | null;
    kakao_id: string | null;
    company_email: string | null;
    department_code: string;
    role: string;
  };
};

const FIELDS = [
  { key: 'employeeId', label: '사번 (등록 후 변경 불가)', type: 'text', max: 40, required: true },
  { key: 'name', label: '이름', type: 'text', max: 40, required: true },
  { key: 'phone', label: '휴대전화', type: 'tel', max: 20, required: true },
  { key: 'kakaoId', label: '카카오톡 ID (연락 참고용)', type: 'text', max: 100, required: true },
  { key: 'companyEmail', label: '회사 이메일 (선택)', type: 'email', max: 254, required: false },
] as const;

export default function Onboarding() {
  const [info, setInfo] = useState<Info | null>(null);
  const [departments, setDepartments] = useState<MasterData['departments']>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ employeeId: '', name: '', department: '', phone: '', kakaoId: '', companyEmail: '' });

  useEffect(() => {
    let active = true;
    api<MasterData>('/api/meta').then((m) => active && setDepartments(m.departments), () => {});
    api<Info>('/api/auth/google/onboarding').then(
      (r) => {
        if (!active) return;
        setInfo(r);
        setForm({
          employeeId: r.employee?.employee_id ?? '',
          name: r.employee?.name ?? r.name,
          department: r.employee?.department_code ?? '', // new employees must choose explicitly
          phone: r.employee?.phone ?? '',
          kakaoId: r.employee?.kakao_id ?? '',
          companyEmail: r.employee?.company_email ?? '',
        });
      },
      (e: Error) => active && setError(e.message),
    );
    return () => {
      active = false;
    };
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ next: string }>('/api/auth/google/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      location.assign(r.next);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const deptLabel = (code: string) => departments.find((d) => d.code === code)?.label ?? code;

  return (
    <>
      <TopBar />
      <main className="page" style={{ maxWidth: 520 }}>
        <h1>{info?.linking ? 'Google 계정 연결' : '직원 정보 등록'}</h1>
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
        {info ? (
          <form className="card" onSubmit={submit}>
            <p>확인된 Google 계정: {info.email}</p>
            <p className="muted" style={{ fontSize: 14 }}>
              사번은 직원의 고유 식별자입니다. Google 이메일 · 회사 이메일 · 알림 수신 정보는 서로 별개입니다.
            </p>
            {FIELDS.map((f) => (
              <div className="field" key={f.key}>
                <label htmlFor={f.key}>{f.label}</label>
                <input
                  id={f.key}
                  className="input"
                  type={f.type}
                  maxLength={f.max}
                  required={f.required}
                  readOnly={info.linking && (f.key === 'name' || (f.key === 'employeeId' && !!info.employee?.employee_id))}
                  value={form[f.key]}
                  onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                />
              </div>
            ))}
            <div className="field">
              <label htmlFor="department">부서</label>
              {info.linking ? (
                <input id="department" className="input" readOnly value={deptLabel(form.department)} />
              ) : (
                <select
                  id="department"
                  className="select"
                  required
                  value={form.department}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                >
                  <option value="">— 부서 선택 —</option>
                  {departments.map((d) => (
                    <option key={d.code} value={d.code}>
                      {d.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <p>역할: {info.employee?.role ?? 'RESPONDER'} · 다른 역할은 관리자만 지정합니다.</p>
            <p className="muted" style={{ fontSize: 14 }}>
              전화번호와 카카오톡 ID는 연락 참고용이며, 인증된 알림 수신자가 아니므로 알림 발송에 사용되지 않습니다.
            </p>
            <button className="btn btn-primary btn-big btn-block" disabled={busy}>
              {busy ? '저장 중…' : info.linking ? '계정 연결 완료' : '등록 완료'}
            </button>
          </form>
        ) : (
          !error && <p className="muted">Google 인증 정보를 확인하는 중…</p>
        )}
        <p style={{ marginTop: 16 }}>
          <Link href="/login">로그인으로 돌아가기</Link> · <Link href="/operator">로그인 없이 ANDON 호출</Link>
        </p>
      </main>
    </>
  );
}
