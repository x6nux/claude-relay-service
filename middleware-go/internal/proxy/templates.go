package proxy

import (
	"embed"
	"fmt"
	"html/template"
	"io"
	"strings"
)

//go:embed templates/*.html
var templateFS embed.FS

// LoadEmbeddedTemplates 加载嵌入的HTML模板
func LoadEmbeddedTemplates() (*template.Template, error) {
	// 读取所有模板文件
	entries, err := templateFS.ReadDir("templates")
	if err != nil {
		return nil, fmt.Errorf("failed to read templates directory: %w", err)
	}

	// 创建一个新的模板
	tmpl := template.New("")

	// 遍历所有模板文件
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".html") {
			// 读取模板内容
			content, err := templateFS.ReadFile("templates/" + entry.Name())
			if err != nil {
				return nil, fmt.Errorf("failed to read template %s: %w", entry.Name(), err)
			}

			// 解析模板并添加到集合中
			_, err = tmpl.New(entry.Name()).Parse(string(content))
			if err != nil {
				return nil, fmt.Errorf("failed to parse template %s: %w", entry.Name(), err)
			}
			
			fmt.Printf("✅ Loaded embedded template: %s (%d bytes)\n", entry.Name(), len(content))
		}
	}

	return tmpl, nil
}

// RenderTemplate 渲染指定的模板
func RenderTemplate(w io.Writer, tmpl *template.Template, name string, data interface{}) error {
	return tmpl.ExecuteTemplate(w, name, data)
}