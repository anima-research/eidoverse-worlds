// In-memory mutations of the production modules; never rewrites the checkout.
import { plugin } from "bun";
import { readFileSync } from "node:fs";
const mutation = JSON.parse(process.env.BODY_STATE_MUTATION!);
plugin({ name: "body-state-red-control", setup(build) {
  build.onLoad({ filter: new RegExp("/mcpl/" + mutation.file.replace(/\./g, "\\.") + "$") }, args => {
    const src = readFileSync(args.path, "utf8");
    if (src.split(mutation.from).length !== 2) throw new Error("mutation anchor changed");
    console.error("BODY_STATE_MUTATION_APPLIED");
    return { contents: src.replace(mutation.from, mutation.to), loader: "ts" };
  });
} });
