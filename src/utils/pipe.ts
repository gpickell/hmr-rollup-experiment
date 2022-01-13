import { Readable, Writable, Duplex } from "stream";

interface ErrorHandler {
    (err?: Error | null): any;
}

export function fifo(objectMode = false): [Readable, Writable] {
    let idle = false;
    let next: ErrorHandler | undefined;
    let push: [any, BufferEncoding?] | undefined;
    let reader: Readable | undefined = new Readable({
        objectMode,
        autoDestroy: true,
        
        destroy(err, cb) {
            setImmediate(cb, err);
            next && setImmediate(next);

            const _ = writer;
            push = undefined;
            next = undefined;
            reader = undefined;
            writer = undefined;
            _?.destroy();
        },

        read() {
            idle = true;
            writer ? pump() : this.destroy();
        },
    });

    let writer: Writable | undefined = new Writable({
        objectMode,
        autoDestroy: true,
        
        destroy(err, cb) {
            setImmediate(cb, err);
            next && setImmediate(next, err);

            const _ = reader;
            push = undefined;
            next = undefined;
            reader = undefined;
            writer = undefined;
            idle && _?.destroy();
        },

        write(chunk, encoding, cb) {
            push = [chunk, encoding];
            next = cb;
            pump();
        },

        final(cb) {
            push = [null];
            next = cb;
            pump();
        },
    });

    let pending = false;
    const pump = () => {
        pending || setImmediate(() => {
            pending = false;

            if (idle) {
                if (push) {
                    const _ = reader;
                    const [chunk, encoding] = push;                    
                    idle = false;
                    push = undefined;

                    if (chunk === null) {
                        reader = undefined;
                        writer = undefined;
                    }

                    _?.push(chunk, encoding);
                } else {
                    const _ = next;
                    next = undefined;
                    _?.();
                }
            }
        });

        pending = true;
    };

    return [reader, writer];
}

export function swallow(objectMode = false) {
    return new Duplex({
        objectMode,
        autoDestroy: true,

        read() {
            this.push(null);
        },

        write(_, __, cb) {
            setImmediate(cb);
        },

        final(cb) {
            setImmediate(cb);
        },

        destroy(err, cb) {
            setImmediate(cb, err);
        },
    });
}