import { useState } from 'react';
import { api, type Invite } from '../api.js';
import { ErrorBox, useLoader } from '../components/ui.js';
import { navigate } from '../router.js';

export function JoinPage({ token }: { token: string }) {
  const { data, error } = useLoader(() => api<{ invite: Invite }>('GET', `/invites/${token}`).then((r) => r.invite), [token]);
  const [choice, setChoice] = useState<number | 'new'>('new');
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<unknown>(null);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="empty">Laden…</div>;
  if (data.alreadyMember) {
    navigate(`/groups/${data.groupId}`, true);
    return null;
  }
  const open = data.members.filter((m) => !m.claimed);

  async function join() {
    setBusy(true);
    try {
      const { groupId } = await api<{ groupId: number }>('POST', `/invites/${token}/join`, {
        memberId: choice === 'new' ? null : choice,
      });
      navigate(`/groups/${groupId}`, true);
    } catch (err) {
      setJoinError(err);
      setBusy(false);
    }
  }

  return (
    <div className="auth stack">
      <div className="hero">
        <h1>Einladung zu «{data.name}»</h1>
        <p>Wähle, wer du in dieser Gruppe bist.</p>
      </div>
      <div className="card stack">
        <ErrorBox error={joinError} />
        {open.map((m) => (
          <label key={m.id} className="row" style={{ cursor: 'pointer' }}>
            <input type="radio" name="who" checked={choice === m.id} onChange={() => setChoice(m.id)} />
            Ich bin <strong>{m.name}</strong>
          </label>
        ))}
        <label className="row" style={{ cursor: 'pointer' }}>
          <input type="radio" name="who" checked={choice === 'new'} onChange={() => setChoice('new')} />
          Als neues Mitglied beitreten
        </label>
        <button className="primary" onClick={join} disabled={busy}>
          Beitreten
        </button>
      </div>
    </div>
  );
}
