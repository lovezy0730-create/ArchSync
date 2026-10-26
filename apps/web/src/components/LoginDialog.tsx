import { useState } from 'react';
import { useStore } from '../store.js';

export function LoginDialog() {
  const identity = useStore((s) => s.identity);
  const setIdentity = useStore((s) => s.setIdentity);
  const team = useStore((s) => s.team);
  const teamDemo = useStore((s) => s.teamDemo);
  const booted = useStore((s) => s.booted);
  const mode = useStore((s) => s.mode);
  const authMode = useStore((s) => s.authMode);
  const codeAuthenticated = useStore((s) => s.codeAuthenticated);
  const submitAccessCode = useStore((s) => s.submitAccessCode);

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codePending, setCodePending] = useState(false);

  // static mode has no identity/presence concepts at all
  if (!booted || identity || mode === 'static') return null;

  return (
    <div className="login-overlay" role="dialog" aria-label="进入工作台">
      <div className="login-card">
        <div className="login-brand"><span className="brand-mark">A</span> ArchSync</div>
        <h2>进入工作台</h2>
        {authMode === 'code' && !codeAuthenticated ? (
          <>
            <p className="login-hint">
              此部署启用了访问码保护。请输入服务端 <code>AUTH_CODE</code> 中设置的访问码；
              验证通过后再选择显示名进入。
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (code.trim().length === 0 || codePending) return;
                setCodePending(true);
                setCodeError(null);
                const err = await submitAccessCode(code.trim());
                setCodePending(false);
                if (err) setCodeError(err);
              }}
            >
              <input
                autoFocus
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="访问码"
                maxLength={256}
              />
              <button type="submit" className="primary" disabled={code.trim().length === 0 || codePending}>
                {codePending ? '验证中…' : '验证'}
              </button>
            </form>
            {codeError && <div className="conflict-note">⚠ {codeError}</div>}
          </>
        ) : (
          <>
            <p className="login-hint">
              {authMode === 'code'
                ? '访问码验证通过。输入你的显示名（协作界面标识，所有成员可见）进入工作台。'
                : '演示模式（仅限本机 127.0.0.1）：输入你的显示名，或从示例团队成员中选择一个身份，用于多人实时协作演示。该名称只作为界面标签，不是真实鉴权。'}
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (name.trim().length > 0) setIdentity({ name: name.trim().slice(0, 32) });
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="输入显示名，例如：访客"
                maxLength={32}
              />
              <button type="submit" className="primary" disabled={name.trim().length === 0}>
                进入
              </button>
            </form>
            {authMode !== 'code' && team.length > 0 && (
              <>
                <div className="login-divider">
                  <span>{teamDemo ? '或选择演示团队成员' : '或选择项目成员'}</span>
                </div>
                <div className="team-picker">
                  {team.slice(0, 8).map((member) => (
                    <button key={member.login} onClick={() => setIdentity({ name: member.name })}>
                      <span className="avatar">{member.name.slice(0, 1)}</span>
                      {member.name}
                      <code>@{member.login}</code>
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
