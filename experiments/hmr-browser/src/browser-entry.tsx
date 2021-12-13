import hmr from "dist/hmr";

import React from 'react';
import ReactDOM from 'react-dom';

import App from './App';

if (hmr.ready) {
    console.log("---", hmr.state, hmr.meta instanceof HTMLDivElement);

    const div: HTMLDivElement = hmr.meta || document.createElement("div");
    hmr.keep(div);

    if (div.parentNode === null) {
        document.body.append(div);
    }

    const jsx =
    <React.StrictMode>
        <App />
    </React.StrictMode>;

    ReactDOM.render(jsx, div);
}
