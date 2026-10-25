import { useState } from 'react';
import { useStore } from '../store.js';

export function LoginDialog() {
  const identity = useStore((s) => s.identity);
  const setIdentity = useStore((s) => s.setIdentity);
  const team = useStore((s) => s.team);
  const teamDemo = useStore((s) => s.teamDemo);
  const booted = useStore((s) => s.booted);

  const [name, setName] = useState('');

  if (!booted || identity) return null;

  return (
    <div className="login-overlay" role="dialog" aria-label="选择身份">
      <div className="login-card">
        <div className="login-brand"><span className="brand-mark">A</span> ArchSync</div>
        <h2>进入工作台</h2>
        <p className="login-hint">
          演示模式（仅限本机 127.0.0.1）：输入你的显示名，或从示例团队成员中选择一个身份，
          用于多人实时协作演示。该名称只作为界面标签，不是真实鉴权。
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
        {team.length > 0 && (
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
      </div>
    </div>
  );
}
