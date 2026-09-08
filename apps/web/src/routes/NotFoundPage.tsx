import { Link } from 'react-router-dom';

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="panel">
      <h1>Not found</h1>
      <p>There is nothing at this address.</p>
      <Link to="/">Back to the control plane</Link>
    </div>
  );
}
