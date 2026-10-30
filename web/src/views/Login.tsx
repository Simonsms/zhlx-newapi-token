import { useState, type FormEvent, type ReactNode } from 'react';
import { api, post, type Session } from '../api';

export function Login({ configured, onDone }: { configured: boolean; onDone: (session: Session) => void }): ReactNode {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await post<{ ok: boolean }>('login', { token });
      const session = await api<Session>('session');
      onDone(session);
    } catch (cause) {
      const message = (cause as Error).message;
      setError(message === 'invalid_credentials' ? '令牌不正确' : `登录失败：${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={(event) => void submit(event)}>
        <h1>New API 用量与 Prompt 采集</h1>
        <p>查看原生用量、采集范围与请求本体结果。</p>
        {!configured ? <div className="error-box">管理接口未配置：请设置 ADMIN_API_TOKEN 后重启服务。</div> : null}
        <label htmlFor="token">管理员令牌</label>
        <input
          id="token"
          type="password"
          autoComplete="current-password"
          placeholder="ADMIN_API_TOKEN"
          value={token}
          disabled={!configured}
          onChange={(event) => setToken(event.target.value)}
        />
        <button className="primary" type="submit" disabled={!configured || busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <div className="error" role="alert">{error}</div>
        <p className="tiny muted" style={{ marginTop: 12 }}>令牌在服务端配置，浏览器仅保存签名会话 Cookie。</p>
      </form>
    </div>
  );
}
