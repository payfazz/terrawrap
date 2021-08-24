import * as path from "https://deno.land/std@0.103.0/path/mod.ts";
import { parse as parseYml } from "https://deno.land/std@0.103.0/encoding/yaml.ts";

interface ConfigInner {
  "s3_backend": {
    "role_arn": string;
    "region": string;
    "bucket": string;
    "dynamodb_table": string;
  };
  "execution": {
    "prefix"?: string;
    "aws_execution_role"?: string;
  }[];
}

interface Config {
  file: string;
  workingDir: string;
  key: string;
  config: ConfigInner;
}

const panic = (msg: string): never => {
  console.error(msg);
  Deno.exit(1);
};

const log =
  (() =>
    Deno.env.get("TERRAWRAP_LOG") == "true"
      ? (msg: string): void => console.log(`[terrawrap]: ${msg}`)
      : () => {})();

const isValidString = <T>(s: T) => typeof s == "string" && s.length > 0;

const workingDir: string = (() => {
  const chdirRe = /-?-chdir($|=(.*$))/;
  let cwd: string | null = null;
  for (let i = 0; i < Deno.args.length; i++) {
    const match = Deno.args[i].match(chdirRe);
    if (match == null) continue;
    if (cwd != null) panic("Invalid multiple -chdir option");
    cwd = match[2] ?? Deno.args[++i];
    if (!isValidString(cwd)) panic("Invalid -chdir option");
  }
  return path.resolve(cwd ?? Deno.cwd());
})();

function* allPossibleConfigLocation(): Generator<string, void, void> {
  let dir = workingDir;
  while (true) {
    yield path.join(dir, "wrapper-config.yml");
    yield path.join(dir, "wrapper-config.yaml");
    const newDir = path.dirname(dir);
    if (newDir == dir) {
      break;
    }
    dir = newDir;
  }
}

const loadConfig = async (): Promise<Config | null> => {
  for (const configFile of allPossibleConfigLocation()) {
    let parsed: ConfigInner | null = null;
    try {
      parsed = parseYml(await Deno.readTextFile(configFile)) as ConfigInner;
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      panic(`File: ${configFile}\n${e}`);
    }

    const errors: string[] = [];
    if (!isValidString(parsed?.s3_backend?.role_arn)) {
      errors.push(`Invalid ".s3_backend.role_arn"`);
    }
    if (!isValidString(parsed?.s3_backend?.region)) {
      errors.push(`Invalid ".s3_backend.region"`);
    }
    if (!isValidString(parsed?.s3_backend?.bucket)) {
      errors.push(`Invalid ".s3_backend.bucket"`);
    }
    if (!isValidString(parsed?.s3_backend?.dynamodb_table)) {
      errors.push(`Invalid ".s3_backend.dynamodb_table"`);
    }
    if (!Array.isArray(parsed?.execution)) {
      errors.push(`Invalid ".execution"`);
    }
    if (errors.length > 0) {
      panic(`Config error: ${configFile}\n${errors.join("\n")}`);
    }

    return {
      file: configFile,
      workingDir,
      key: workingDir.slice(path.dirname(configFile).length + 1),
      config: parsed!,
    };
  }
  return null;
};

const terraform = async (
  before?: () => Promise<void>,
  after?: () => Promise<void>,
): Promise<number> => {
  try {
    if (before) await before();
    if (Deno.env.get("TERRAWRAP_NO_TERRAFORM") == "true") {
      return 0;
    }
    const status = await Deno.run({ cmd: ["terraform", ...Deno.args] })
      .status();
    return (status.signal == null) ? status.code : 1;
  } finally {
    if (after) await after();
  }
};

const config = await loadConfig();

if (config == null) {
  log("No config found");
  Deno.exit(await terraform());
}

log(`Config: ${config.file}`);
log(`Working directory: ${config.workingDir}`);
log(`Key: ${config.key}`);

if (!isValidString(config.key)) {
  panic(
    `Working directory must be in subdirectory of config file ${config.file}`,
  );
}

let executionRole = "";
for (const o of config.config.execution) {
  if (config.key.startsWith(o?.prefix!)) {
    executionRole = o?.aws_execution_role!;
    if (isValidString(executionRole)) break;
  }
}

if (!isValidString(executionRole)) {
  panic(`No execution role is found in ${config.file} for key ${config.key}`);
}

log(`Execution Role: ${executionRole}`);

const backend = config.config.s3_backend;
const generatedFile = path.join(config.workingDir, "00_generated.tf");
const generatedContent = `# THIS FILE IS GENERATED, DO NOT EDIT, DO NOT COMMIT

terraform {
  backend "s3" {
    role_arn       = "${backend.role_arn}"
    region         = "${backend.region}"
    bucket         = "${backend.bucket}"
    dynamodb_table = "${backend.dynamodb_table}"
    key            = "${config.key}"
  }
}

locals {
  generated = {
    state_key          = "${config.key}"
    aws_execution_role = "${executionRole}"
    remote_state = {
      backend = "s3"
      config = {
        role_arn       = "${backend.role_arn}"
        region         = "${backend.region}"
        bucket         = "${backend.bucket}"
        dynamodb_table = "${backend.dynamodb_table}"
      }
    }
  }
}
`;

log(`zz_generated.tf:\n${generatedContent}`);

Deno.exit(
  await terraform(
    () => Deno.writeTextFile(generatedFile, generatedContent),
    async () => {
      if (!(Deno.env.get("TERRAWRAP_NO_CLEANUP") == "true")) {
        await Deno.remove(generatedFile);
      }
    },
  ),
);
