export enum State {
    pending = "pending",
    running = "running",
    upgrade = "upgrade",
}

const immediate = Promise.resolve();

export interface Update {
    meta?: any;
    state: State;
}

class HotModuleContext {
    protected _handlers = new Map<() => any, () => any>();
    protected _meta?: any;
    protected _state?: State;
    protected _update?: Update;

    private _transition() {
        const { _update } = this;
        if (_update !== undefined) {
            const { state } = _update;
            this._state = state;

            if (state === State.upgrade) {
                this._update = undefined;
            }

            for (const handler of this._handlers.values()) {
                immediate.then(handler);
            }
        }
    }

    get meta() {
        return this._meta;
    }

    get ready() {
        return this.state !== State.upgrade;
    }

    get state() {
        return this._state ?? State.running;
    }

    get static() {
        return this._update === undefined;
    }

    constructor(meta?: any, _update?: State | Update) {
        this._meta = meta;
        if (typeof _update === "object") {
            this._update = _update;
            this._state = _update.state;
        } else {
            this._state = _update;
        }
    }

    on(event: "start" | "stop", listener: () => any) {
        const { _handlers } = this;
        let handler = listener;
        if (event === "start") {
            handler = () => {
                if (_handlers.has(listener)) {
                    const { state } = this;
                    if (state !== State.pending) {
                        _handlers.delete(listener);
                    }

                    if (state === State.running) {
                        listener();
                    }
                }
            };
        }

        if (event === "stop") {
            if (this.static) {
                return false;
            }

            handler = () => {
                if (_handlers.has(listener)) {
                    const { state } = this;
                    if (state === State.upgrade) {
                        _handlers.delete(listener);
                        listener();
                    }
                }
            };
        }

        if (handler === listener) {
            return false;
        }

        _handlers.set(listener, handler);

        if (this.state !== State.pending) {
            immediate.then(handler); 
        }

        return true;
    }

    off(listener: () => any) {
        const { _handlers } = this;
        return _handlers.delete(listener);
    }

    keep(meta: any) {
        const { _update } = this;
        if (_update === undefined) {
            return false;
        }

        _update.meta = meta;
        return true;
    }

    invalidate() {
        immediate.then(() => this._transition());
    }

    toString() {
        return this.state;
    }
}

export default HotModuleContext;
