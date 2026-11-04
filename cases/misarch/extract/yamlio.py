"""YAML in the curated style: mappings whose values are all scalars (or short scalar lists) are
written in flow style on one line, everything else in block style."""

import yaml


class _Dumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def _is_flat(v):
    if isinstance(v, dict):
        return all(not isinstance(x, (dict, list)) or (isinstance(x, list) and all(not isinstance(y, (dict, list)) for y in x)
                                                       and len(x) <= 6) for x in v.values())
    return False


def _repr_dict(dumper, data):
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items(), flow_style=_is_flat(data) and len(data) > 0
                                    and len(str(data)) < 200)


def _repr_list(dumper, data):
    flat = all(not isinstance(x, (dict, list)) for x in data)
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=flat and len(str(data)) < 100)


_Dumper.add_representer(dict, _repr_dict)
_Dumper.add_representer(list, _repr_list)


def dump(doc):
    return yaml.dump(doc, Dumper=_Dumper, sort_keys=False, width=120, allow_unicode=True)


def load(text):
    return yaml.safe_load(text)
