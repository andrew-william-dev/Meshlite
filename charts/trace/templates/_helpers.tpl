{{- define "trace.name" -}}
trace
{{- end -}}

{{- define "trace.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
