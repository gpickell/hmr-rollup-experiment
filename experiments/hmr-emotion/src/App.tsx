import css from "./App.scss";
import logo from './logo.svg';

import { cx } from "@emotion/css";

function App() {
    const jsx = <>
        <div className={cx("App", css)}>
            <header className="App-header">
                <img src={logo} className="App-logo" alt="logo" />
                <p>
                    Edit <code>src/App.js</code> and save to reload.
                </p>
                <a className="App-link" href="https://reactjs.org" target="_blank" rel="noopener noreferrer">
                    Learn React
                </a>
                <div className="edit">
                    test edit test
                </div>
            </header>
        </div>
        <table>
            <tr>
                <td>
                    process.env:
                </td>
                <td>
                    {JSON.stringify(process.env, undefined, 4)}
                </td>
            </tr>
            <tr>
                <td>
                    process.versions:
                </td>
                <td>
                    {JSON.stringify(process.versions, undefined, 4)}
                </td>
            </tr>
        </table>
    </>;

    return jsx;
}

export default App;
